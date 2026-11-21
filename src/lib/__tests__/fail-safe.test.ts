import { beforeEach, describe, expect, it, vi } from "vitest";
import { whenIdle } from "@/lib/investigations";
import { getSnapshot } from "@/lib/snapshot";
import { attackerSession, freshStore, runScenario } from "./helpers";

vi.mock("@/lib/investigator", () => ({
  getLlmStatus: () => ({ configured: false, model: null }),
  runInvestigation: vi.fn(async () => {
    throw new Error("LLM exploded");
  }),
}));

beforeEach(freshStore);

describe("fail-safe without a working investigator", () => {
  it("keeps the payment held and the session restricted, and still opens an incident", async () => {
    const s = runScenario("B");
    const attacker = attackerSession(s);
    const payment = s.payments.find((p) => p.sessionId === attacker.id)!;
    await whenIdle();

    const after = getSnapshot();
    expect(after.payments.find((p) => p.id === payment.id)?.status).toBe("HELD");
    expect(after.sessions.find((x) => x.id === attacker.id)?.status).toBe("RESTRICTED");
    expect(after.customer.balance).toBe(92000);
    expect(after.investigations.find((i) => i.paymentId === payment.id)?.status).toBe("FAILED");
    const incident = after.incidents.find((i) => i.paymentId === payment.id);
    expect(incident).toBeDefined();
    expect(incident?.createdBy).toBe("policy-gateway");
    expect(after.audit.map((e) => e.action)).toContain("INVESTIGATION_FAILED");
  });
});
