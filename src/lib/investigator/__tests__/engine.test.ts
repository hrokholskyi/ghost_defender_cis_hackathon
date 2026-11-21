import { describe, expect, it } from "vitest";
import { createInvestigator } from "../index";
import type { EngineRunInput, LlmEngine } from "../engine";
import { atoContext, fakeTools, recordingSink, toolSteps } from "./fixtures";

const VALID_VERDICT = {
  assessment: "LIKELY_ACCOUNT_TAKEOVER",
  summary: "New Android login 45 minutes after a SIM swap, then a large transfer to a new payee. The payment should stay held.",
  evidence: ["Unknown device Galaxy A54", "SIM swap 45 minutes before login"],
  recommendedAction: "HOLD_AND_RESTRICT",
  incidentId: "INC-FAKE",
};

function engine(run: (input: EngineRunInput) => Promise<unknown>): LlmEngine {
  return { id: "devin", model: "devin-test", run };
}

async function readAll(tools: EngineRunInput["tools"]) {
  await Promise.all([
    tools.get_device_history(),
    tools.get_sim_status(),
    tools.get_session_activity(),
    tools.get_payment_history(),
    tools.check_beneficiary(),
  ]);
}

const env = {};

describe("LLM engine path", () => {
  it("runs a well-behaved engine and reports its tool calls", async () => {
    const sink = recordingSink();
    const tools = fakeTools();
    const investigate = createInvestigator({
      env,
      engine: engine(async ({ tools: t, note }) => {
        note("Checking the session signals.");
        note("   ");
        await readAll(t);
        await t.create_incident({ title: "Suspected ATO", severity: "CRITICAL", reasons: ["SIM swap"] });
        return VALID_VERDICT;
      }),
    });
    const result = await investigate(atoContext(), tools, sink);

    expect(sink.engines).toEqual([{ engine: "devin", model: "devin-test" }]);
    expect(result).toMatchObject({ engine: "devin", model: "devin-test" });
    expect(result.fallbackReason).toBeUndefined();
    expect(result.verdict).toMatchObject({ assessment: "LIKELY_ACCOUNT_TAKEOVER", recommendedAction: "HOLD_AND_RESTRICT" });
    // The incident id comes from the real tool result, not from the engine payload.
    expect(result.verdict.incidentId).toBe("INC-0001");

    const steps = toolSteps(sink);
    expect(steps).toHaveLength(6);
    expect(steps.every((s) => s.status === "ok")).toBe(true);
    for (const step of steps) {
      const started = sink.events.find((e) => e.type === "started" && e.step.id === step.id);
      expect(started?.step).toMatchObject({ status: "running" });
    }
    expect([...tools.calls].sort()).toEqual(
      ["check_beneficiary", "create_incident", "get_device_history", "get_payment_history", "get_session_activity", "get_sim_status"],
    );
    const notes = sink.steps().filter((s) => s.kind === "note");
    expect(notes).toHaveLength(1);
  });

  it("falls back when the engine throws, reusing fetched results", async () => {
    const sink = recordingSink();
    const tools = fakeTools();
    const result = await createInvestigator({
      env,
      engine: engine(async ({ tools: t }) => {
        await t.get_device_history();
        await t.get_sim_status();
        throw new Error("Devin API returned 503");
      }),
    })(atoContext(), tools, sink, { stepDelayMs: 0 });

    expect(result.engine).toBe("deterministic-fallback");
    expect(result.fallbackReason).toBe("Devin engine failed: Devin API returned 503");
    expect(sink.engines).toEqual([
      { engine: "devin", model: "devin-test" },
      { engine: "deterministic-fallback", fallbackReason: "Devin engine failed: Devin API returned 503" },
    ]);
    expect(result.verdict.assessment).toBe("LIKELY_ACCOUNT_TAKEOVER");
    expect(result.verdict.incidentId).toBe("INC-0001");
    for (const name of new Set(tools.calls)) {
      expect(tools.calls.filter((c) => c === name)).toHaveLength(1);
    }
    expect(tools.calls).toHaveLength(6);
  });

  it("falls back when the engine never finishes, and refuses its late tool calls", async () => {
    const sink = recordingSink();
    const tools = fakeTools();
    let engineTools: EngineRunInput["tools"] | undefined;
    let signal: AbortSignal | undefined;
    const result = await createInvestigator({
      env,
      engineTimeoutMs: 20,
      engine: engine((input) => {
        engineTools = input.tools;
        signal = input.signal;
        return new Promise(() => {});
      }),
    })(atoContext(), tools, sink, { stepDelayMs: 0 });

    expect(result.engine).toBe("deterministic-fallback");
    expect(result.fallbackReason).toBe("Devin engine did not finish within 20 ms");
    expect(signal?.aborted).toBe(true);
    expect(result.verdict.incidentId).toBe("INC-0001");

    const callsBefore = tools.calls.length;
    await expect(engineTools!.get_device_history()).rejects.toThrow(/refused/);
    expect(tools.calls.length).toBe(callsBefore);
  });

  it("falls back on an invalid verdict", async () => {
    const sink = recordingSink();
    const result = await createInvestigator({
      env,
      engine: engine(async ({ tools: t }) => {
        await readAll(t);
        return { ...VALID_VERDICT, recommendedAction: "RELEASE" };
      }),
    })(atoContext(), fakeTools(), sink, { stepDelayMs: 0 });

    expect(result.engine).toBe("deterministic-fallback");
    expect(result.fallbackReason).toMatch(/^Devin engine returned an invalid verdict \(recommendedAction: /);
    expect(result.verdict.recommendedAction).toBe("HOLD_AND_RESTRICT");
    expect(sink.engines).toHaveLength(2);
  });

  it("reports a read tool that throws inside an engine run as an error step", async () => {
    const sink = recordingSink();
    const tools = fakeTools({
      check_beneficiary: async () => {
        throw new Error("beneficiary service down");
      },
    });
    let caught: unknown;
    const result = await createInvestigator({
      env,
      engine: engine(async ({ tools: t }) => {
        try {
          await readAll(t);
        } catch (err) {
          caught = err;
        }
        return VALID_VERDICT;
      }),
    })(atoContext(), tools, sink);

    expect((caught as Error).message).toBe("beneficiary service down");
    expect(toolSteps(sink).find((s) => s.tool === "check_beneficiary")).toMatchObject({
      status: "error",
      error: "beneficiary service down",
    });
    expect(result.engine).toBe("devin");
    // HOLD verdict without an incident from the engine: the orchestrator opens one.
    expect(result.verdict.incidentId).toBe("INC-0001");
  });

  it("rejects invalid create_incident input from an engine without calling the core", async () => {
    const sink = recordingSink();
    const tools = fakeTools();
    let error: unknown;
    await createInvestigator({
      env,
      engine: engine(async ({ tools: t }) => {
        try {
          await t.create_incident({ title: "x", severity: "APOCALYPTIC" as never, reasons: [] });
        } catch (err) {
          error = err;
        }
        return { ...VALID_VERDICT, recommendedAction: "STEP_UP", assessment: "SUSPICIOUS" };
      }),
    })(atoContext(), tools, sink);

    expect((error as Error).message).toMatch(/Invalid create_incident input/);
    expect(tools.calls).not.toContain("create_incident");
    expect(toolSteps(sink)[0]).toMatchObject({ tool: "create_incident", status: "error" });
  });
});
