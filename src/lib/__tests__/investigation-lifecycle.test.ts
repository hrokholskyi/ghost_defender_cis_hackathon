import { beforeEach, describe, expect, it, vi } from "vitest";
import { addBeneficiary, login, reportSimSwap } from "@/lib/bank";
import { whenIdle } from "@/lib/investigations";
import { createInvestigator } from "@/lib/investigator/orchestrator";
import { createDevinEngine } from "@/lib/investigator/devin/engine";
import { activeGrantCount } from "@/lib/investigator/devin/grants";
import { fakeDevinClient, neverSleep, PUBLIC_URL } from "@/lib/investigator/__tests__/devin-fakes";
import { requestTransfer } from "@/lib/payment-gateway";
import { startScenario } from "@/lib/scenarios";
import { getSnapshot } from "@/lib/snapshot";
import type { InvestigationTools, RunInvestigation } from "@/lib/types";
import { freshStore, runScenario } from "./helpers";

const control = vi.hoisted(() => ({ impl: null as RunInvestigation | null }));

vi.mock("@/lib/investigator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/investigator")>();
  const runInvestigation: RunInvestigation = (ctx, tools, sink, options) => {
    if (!control.impl) throw new Error("no investigator set");
    return control.impl(ctx, tools, sink, options);
  };
  return { ...actual, getLlmStatus: () => ({ configured: true, model: "Devin" }), runInvestigation };
});

beforeEach(async () => {
  await freshStore();
  control.impl = null;
});

/** Wraps an investigator so the test sees every engine switch and every real tool call. */
function observed(inner: RunInvestigation) {
  const seen = { engines: [] as string[], toolCalls: [] as string[] };
  const run: RunInvestigation = (ctx, tools, sink, options) => {
    const counted = Object.fromEntries(
      Object.entries(tools).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          seen.toolCalls.push(name);
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as InvestigationTools;
    return inner(ctx, counted, {
      ...sink,
      engineSelected(info) {
        seen.engines.push(info.engine);
        sink.engineSelected(info);
      },
    }, options);
  };
  return { run, seen };
}

describe("a reset stops running investigations", () => {
  it("aborts a running Devin investigation: grant ended, session terminated, no fallback, nothing in the new state", async () => {
    const client = fakeDevinClient();
    const engine = createDevinEngine({ client, publicUrl: PUBLIC_URL, sleep: neverSleep });
    const { run, seen } = observed(createInvestigator({ env: {}, engine, engineTimeoutMs: 240_000 }));
    control.impl = run;

    runScenario("B");
    await client.sessionCreated;
    expect(activeGrantCount()).toBe(1);

    const started = Date.now();
    const restarted = startScenario("B");
    await whenIdle();
    expect(Date.now() - started).toBeLessThan(2000);

    expect(activeGrantCount()).toBe(0);
    await vi.waitFor(() => expect(client.terminated).toEqual(["devin-abc123"]));
    expect(seen.engines).toEqual(["devin"]);
    expect(seen.toolCalls).toEqual([]);

    const s = getSnapshot();
    expect(s.investigations).toEqual([]);
    expect(s.incidents).toEqual([]);
    // Only the scenario setup (the iPhone session from the evening before) is in the new state.
    expect(s.audit).toEqual(restarted.audit);
    expect(s.audit.map((e) => e.action)).toEqual(["SCENARIO_STARTED", "LOGIN_SUCCEEDED", "RISK_ASSESSED"]);
    expect(s.seq).toBe(restarted.seq);
  });

  it("stops the deterministic fallback between steps", async () => {
    const inner = createInvestigator({ env: {}, engine: null });
    const { run, seen } = observed((ctx, tools, sink, options) => inner(ctx, tools, sink, { ...options, stepDelayMs: 30 }));
    control.impl = run;

    runScenario("B");
    await vi.waitFor(() => expect(seen.toolCalls.length).toBeGreaterThanOrEqual(1));
    startScenario("B");
    const callsAtReset = seen.toolCalls.length;
    await whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.toolCalls.length).toBeLessThanOrEqual(callsAtReset);
    expect(seen.toolCalls).not.toContain("create_incident");
    expect(getSnapshot().investigations).toEqual([]);
  });
});

describe("the investigator's recommendation is compared with what was applied to its payment", () => {
  it("HOLD on a STEP_UP payment holds it even after a later payment restricted the session", async () => {
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const fallback = createInvestigator({ env: {}, engine: null });
    const firstPaymentId = "pay-001";
    control.impl = async (ctx, tools, sink, options) => {
      if (ctx.paymentId !== firstPaymentId) return fallback(ctx, tools, sink, { ...options, stepDelayMs: 0 });
      await gate;
      return {
        engine: "devin",
        model: "Devin",
        verdict: {
          assessment: "LIKELY_ACCOUNT_TAKEOVER",
          summary: "The session looks like a takeover.",
          evidence: ["SIM swap before login"],
          recommendedAction: "HOLD",
        },
      };
    };

    const attacker = login({
      deviceId: "dev-android-x",
      device: { label: "Samsung Galaxy A54", platform: "Android" },
      network: { ip: "10.88.14.207", city: "Dubai", country: "AE" },
      at: "2026-03-15T10:00:00+04:00",
    }).session;
    reportSimSwap({ swappedAt: "2026-03-15T09:30:00+04:00", at: "2026-03-15T10:01:00+04:00" });
    const { beneficiary } = addBeneficiary(attacker.token, { name: "Mule LLC", iban: "AE00 DEMO 0000 1111 2222 333", at: "2026-03-15T10:02:00+04:00" });

    const first = requestTransfer(attacker.token, { beneficiaryId: "ben-alnoor", amount: 3000, at: "2026-03-15T10:03:00+04:00" });
    expect(first.payment.id).toBe(firstPaymentId);
    expect(first.risk.action).toBe("STEP_UP");
    const second = requestTransfer(attacker.token, { beneficiaryId: beneficiary.id, amount: 85000, at: "2026-03-15T10:04:00+04:00" });
    expect(second.risk.action).toBe("HOLD_AND_RESTRICT");
    expect(getSnapshot().sessions.find((x) => x.id === attacker.id)?.status).toBe("RESTRICTED");

    openGate();
    await whenIdle();
    const s = getSnapshot();
    expect(s.payments.find((p) => p.id === first.payment.id)?.status).toBe("HELD");
    expect(s.incidents.find((i) => i.paymentId === first.payment.id)).toBeDefined();
    const noted = s.audit.filter((e) => e.action === "RECOMMENDATION_NOTED" && e.paymentId === first.payment.id);
    expect(noted).toEqual([]);
  });
});
