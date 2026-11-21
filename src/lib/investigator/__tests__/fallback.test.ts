import { describe, expect, it } from "vitest";
import { createInvestigator, getLlmStatus, runInvestigation } from "../index";
import { FORCED_FALLBACK_REASON } from "../orchestrator";
import type { LlmEngine } from "../engine";
import { atoContext, fakeTools, recordingSink, toolSteps } from "./fixtures";

const READ_ORDER = [
  "get_device_history",
  "get_sim_status",
  "get_session_activity",
  "get_payment_history",
  "check_beneficiary",
];

describe("deterministic fallback", () => {
  it("investigates the account-takeover case end to end", async () => {
    const sink = recordingSink();
    const tools = fakeTools();
    const result = await createInvestigator({ env: {} })(atoContext(), tools, sink, { stepDelayMs: 0 });

    const steps = toolSteps(sink);
    expect(steps.map((s) => s.tool)).toEqual([...READ_ORDER, "create_incident"]);
    expect(steps.every((s) => s.status === "ok")).toBe(true);
    // Each step was reported as running before it finished.
    for (const step of steps) {
      const started = sink.events.find((e) => e.type === "started" && e.step.id === step.id);
      expect(started?.step).toMatchObject({ status: "running" });
    }
    expect(tools.calls).toEqual([...READ_ORDER, "create_incident"]);

    expect(result.engine).toBe("deterministic-fallback");
    expect(result.verdict.assessment).toBe("LIKELY_ACCOUNT_TAKEOVER");
    expect(result.verdict.recommendedAction).toBe("HOLD_AND_RESTRICT");
    expect(result.verdict.incidentId).toBe("INC-0001");

    const evidence = result.verdict.evidence.join("\n");
    expect(evidence).toContain("never seen before: Galaxy A54 (Android)");
    expect(evidence).toContain("SIM swap confirmed 45 minutes before login");
    expect(evidence).toContain("3 minutes after login");
    expect(evidence).toContain("AED 85,000 is 28.3x the typical AED 3,000");
    expect(evidence).toMatch(/"Quick Trading LLC" is new.*added in this same session/);

    const sentences = result.verdict.summary.split(/(?<=\.)\s+/);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.length).toBeLessThanOrEqual(4);
    expect(result.verdict.summary).toContain("INC-0001");
    expect(result.verdict.summary).not.toMatch(/[—–]/);
  });

  it("does not open an incident for STEP_UP", async () => {
    const sink = recordingSink();
    const tools = fakeTools();
    const result = await createInvestigator({ env: {} })(atoContext("STEP_UP", "ELEVATED", 45), tools, sink, { stepDelayMs: 0 });

    expect(tools.calls).not.toContain("create_incident");
    expect(toolSteps(sink).map((s) => s.tool)).toEqual(READ_ORDER);
    expect(result.verdict.assessment).toBe("SUSPICIOUS");
    expect(result.verdict.recommendedAction).toBe("STEP_UP");
    expect(result.verdict.incidentId).toBeUndefined();
  });

  it("keeps going when a read tool throws", async () => {
    const sink = recordingSink();
    const tools = fakeTools({
      get_sim_status: async () => {
        throw new Error("telco signal source offline");
      },
    });
    const result = await createInvestigator({ env: {} })(atoContext(), tools, sink, { stepDelayMs: 0 });

    const steps = toolSteps(sink);
    const sim = steps.find((s) => s.tool === "get_sim_status");
    expect(sim).toMatchObject({ status: "error", error: "telco signal source offline" });
    expect(steps.filter((s) => s.status === "ok")).toHaveLength(5);
    expect(result.verdict.evidence.join("\n")).toContain("SIM status unavailable");
    expect(result.verdict.incidentId).toBe("INC-0001");
  });
});

describe("engine selection", () => {
  it("falls back with a clear reason when there is no engine", async () => {
    const sink = recordingSink();
    const result = await createInvestigator({ env: {}, noEngineReason: "Devin engine not connected yet" })(
      atoContext(),
      fakeTools(),
      sink,
      { stepDelayMs: 0 },
    );
    expect(result).toMatchObject({ engine: "deterministic-fallback", fallbackReason: "Devin engine not connected yet" });
    expect(sink.engines).toEqual([{ engine: "deterministic-fallback", fallbackReason: "Devin engine not connected yet" }]);
  });

  it("GLD_FORCE_FALLBACK=1 skips a configured engine", async () => {
    let ran = false;
    const engine: LlmEngine = {
      id: "devin",
      model: "devin-test",
      run: async () => {
        ran = true;
        return {};
      },
    };
    const sink = recordingSink();
    const result = await createInvestigator({ engine, env: { GLD_FORCE_FALLBACK: "1" } })(atoContext(), fakeTools(), sink, {
      stepDelayMs: 0,
    });
    expect(ran).toBe(false);
    expect(result).toMatchObject({ engine: "deterministic-fallback", fallbackReason: FORCED_FALLBACK_REASON });
    expect(sink.engines).toHaveLength(1);
  });

  it("default runInvestigation runs the fallback (forced in tests)", async () => {
    const sink = recordingSink();
    const result = await runInvestigation(atoContext(), fakeTools(), sink);
    expect(result.engine).toBe("deterministic-fallback");
    expect(result.verdict.incidentId).toBe("INC-0001");
  });

  it("getLlmStatus reports no LLM until the Devin engine is connected", () => {
    expect(getLlmStatus()).toEqual({ configured: false, model: null });
  });
});
