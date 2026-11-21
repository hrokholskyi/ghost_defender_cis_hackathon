import { beforeEach, describe, expect, it, vi } from "vitest";
import { whenIdle } from "@/lib/investigations";
import { getSnapshot } from "@/lib/snapshot";
import type { RunInvestigation } from "@/lib/types";
import { attackerSession, freshStore, runScenario } from "./helpers";

vi.mock("@/lib/investigator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/investigator")>();
  const runInvestigation: RunInvestigation = async (ctx, tools, sink, options) => {
    const result = await actual.runInvestigation(ctx, tools, sink, options);
    return { ...result, verdict: { ...result.verdict, assessment: "LIKELY_LEGITIMATE", recommendedAction: "ALLOW" } };
  };
  return { ...actual, getLlmStatus: () => ({ configured: false, model: null }), runInvestigation };
});

beforeEach(freshStore);

describe("a weaker recommendation than the applied action", () => {
  it("changes nothing and is noted in the audit log", async () => {
    const s = runScenario("B");
    const attacker = attackerSession(s);
    const payment = s.payments.find((p) => p.sessionId === attacker.id)!;
    expect(payment.action).toBe("HOLD_AND_RESTRICT");
    await whenIdle();

    const after = getSnapshot();
    expect(after.investigations.find((i) => i.paymentId === payment.id)?.verdict?.recommendedAction).toBe("ALLOW");
    expect(after.payments.find((p) => p.id === payment.id)?.status).toBe("HELD");
    expect(after.sessions.find((x) => x.id === attacker.id)?.status).toBe("RESTRICTED");
    expect(after.customer.balance).toBe(92000);
    expect(after.incidents.find((i) => i.paymentId === payment.id)).toBeDefined();
    const noted = after.audit.filter((e) => e.action === "RECOMMENDATION_NOTED" && e.paymentId === payment.id);
    expect(noted).toHaveLength(1);
    expect(noted[0].data).toMatchObject({ recommendedAction: "ALLOW", appliedAction: "HOLD_AND_RESTRICT" });
  });
});
