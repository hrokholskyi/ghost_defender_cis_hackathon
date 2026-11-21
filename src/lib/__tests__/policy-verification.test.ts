import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "@/lib/errors";
import { whenIdle } from "@/lib/investigations";
import {
  cancelPayment,
  holdPayment,
  liftRestriction,
  releasePayment,
  restrictSession,
  revokeSession,
} from "@/lib/policy-gateway";
import { getSnapshot } from "@/lib/snapshot";
import { respondToVerification } from "@/lib/verification";
import { attackerSession, auditActions, freshStore, iphoneSession, runScenario } from "./helpers";

beforeEach(freshStore);

function heldScenarioB() {
  const s = runScenario("B");
  const attacker = attackerSession(s);
  const iphone = iphoneSession(s);
  const payment = s.payments.find((p) => p.sessionId === attacker.id)!;
  const verification = s.verifications.find((v) => v.paymentId === payment.id)!;
  return { attacker, iphone, payment, verification };
}

describe("policy gateway", () => {
  it("denies and logs release or lift requested by the AI investigator", async () => {
    const { attacker, payment, iphone, verification } = heldScenarioB();
    await whenIdle();

    const release = releasePayment("ai-investigator", payment.id);
    const lift = liftRestriction("ai-investigator", attacker.id);
    // Even with a proof object, the investigator is not allowed.
    const releaseWithProof = releasePayment("ai-investigator", payment.id, {
      verificationId: verification.id,
      sessionId: iphone.id,
    });
    expect(release.allowed).toBe(false);
    expect(lift.allowed).toBe(false);
    expect(releaseWithProof.allowed).toBe(false);

    const s = getSnapshot();
    expect(s.payments.find((p) => p.id === payment.id)?.status).toBe("HELD");
    expect(s.sessions.find((x) => x.id === attacker.id)?.status).toBe("RESTRICTED");
    expect(s.customer.balance).toBe(92000);
    const denied = s.audit.filter((e) => e.action === "POLICY_DENIED");
    expect(denied).toHaveLength(3);
    expect(denied.every((e) => e.data?.requestedBy === "ai-investigator")).toBe(true);
  });

  it("denies loosening by other actors and without a valid trusted-session proof", () => {
    const { attacker, payment, verification } = heldScenarioB();
    expect(releasePayment("payment-gateway", payment.id).allowed).toBe(false);
    expect(cancelPayment("customer", payment.id).allowed).toBe(false);
    expect(revokeSession("risk-engine", attacker.id).allowed).toBe(false);
    // customer-verification needs a proof from the target session, not the attacker.
    expect(
      releasePayment("customer-verification", payment.id, { verificationId: verification.id, sessionId: attacker.id })
        .allowed,
    ).toBe(false);
    expect(releasePayment("customer-verification", payment.id).allowed).toBe(false);
    expect(getSnapshot().payments.find((p) => p.id === payment.id)?.status).toBe("HELD");
  });

  it("lets tightening actors hold and restrict, but not the customer", () => {
    const { iphone } = heldScenarioB();
    expect(restrictSession("customer", iphone.id, "test").allowed).toBe(false);
    expect(holdPayment("bank-simulator", "pay-h01", "test").allowed).toBe(false);
    const r = restrictSession("ai-investigator", iphone.id, "test");
    expect(r).toMatchObject({ allowed: true, changed: true });
    expect(getSnapshot().sessions.find((x) => x.id === iphone.id)?.status).toBe("RESTRICTED");
  });
});

describe("verification on the trusted device", () => {
  it("refuses an answer with the attacker's token", () => {
    const { attacker, verification, payment } = heldScenarioB();
    let error: unknown;
    try {
      respondToVerification(attacker.token, verification.id, { response: "CONFIRM" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("NOT_TRUSTED_CHANNEL");
    const s = getSnapshot();
    expect(s.payments.find((p) => p.id === payment.id)?.status).toBe("HELD");
    expect(s.verifications.find((v) => v.id === verification.id)?.status).toBe("PENDING");
    expect(auditActions(s)).toContain("VERIFICATION_UNTRUSTED_RESPONSE");
  });

  it("DENY cancels the payment, revokes the attacker and confirms the takeover", async () => {
    const { attacker, iphone, verification, payment } = heldScenarioB();
    await whenIdle();
    const res = respondToVerification(iphone.token, verification.id, { response: "DENY" });
    expect(res.payment.status).toBe("CANCELLED");
    expect(res.verification.status).toBe("DENIED");
    expect(res.balance).toBe(92000);

    const s = getSnapshot();
    expect(s.sessions.find((x) => x.id === attacker.id)?.status).toBe("REVOKED");
    expect(s.sessions.find((x) => x.id === iphone.id)?.status).toBe("ACTIVE");
    expect(s.incidents.find((i) => i.paymentId === payment.id)?.status).toBe("CONFIRMED_ATO");
    expect(s.customer.balance).toBe(92000);
    const actions = auditActions(s);
    expect(actions).toContain("PAYMENT_CANCELLED");
    expect(actions).toContain("SESSION_REVOKED");
    expect(actions).toContain("SECURE_RECOVERY_STARTED");

    let error: unknown;
    try {
      respondToVerification(iphone.token, verification.id, { response: "CONFIRM" });
    } catch (e) {
      error = e;
    }
    expect((error as DomainError).code).toBe("CONFLICT");
  });

  it("DENY before the investigation finishes still ends with CONFIRMED_ATO", async () => {
    const { iphone, verification, payment } = heldScenarioB();
    respondToVerification(iphone.token, verification.id, { response: "DENY" });
    await whenIdle();
    const s = getSnapshot();
    expect(s.incidents.filter((i) => i.paymentId === payment.id)).toHaveLength(1);
    expect(s.incidents[0].status).toBe("CONFIRMED_ATO");
    expect(s.payments.find((p) => p.id === payment.id)?.status).toBe("CANCELLED");
  });

  it("CONFIRM settles the payment and lifts the restriction", async () => {
    const { attacker, iphone, verification, payment } = heldScenarioB();
    await whenIdle();
    const res = respondToVerification(iphone.token, verification.id, { response: "CONFIRM" });
    expect(res.payment.status).toBe("SETTLED");
    expect(res.balance).toBe(7000);
    const s = getSnapshot();
    expect(s.customer.balance).toBe(7000);
    expect(s.sessions.find((x) => x.id === attacker.id)?.status).toBe("ACTIVE");
    expect(s.incidents.find((i) => i.paymentId === payment.id)?.status).toBe("RESOLVED_LEGITIMATE");
    expect(s.beneficiaries.find((b) => b.id === payment.beneficiaryId)?.settledPaymentCount).toBe(1);
  });
});
