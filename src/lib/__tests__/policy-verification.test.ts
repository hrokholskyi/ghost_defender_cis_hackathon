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
import { addBeneficiary, login, reportSimSwap } from "@/lib/bank";
import { requestTransfer } from "@/lib/payment-gateway";
import { getSnapshot } from "@/lib/snapshot";
import { getState } from "@/lib/store";
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

describe("verification never goes to the session that asked for the payment", () => {
  const HOME = { ip: "10.0.0.2", city: "Dubai", country: "AE" };
  const ABROAD = { ip: "203.0.113.9", city: "London", country: "GB" };

  /** SIM swap 08:40, login from the trusted iPhone abroad 09:01, new beneficiary, AED 5,000 at 09:03: risk 65, HOLD. */
  function trustedDeviceTakeover(withOlderIphoneSession: boolean) {
    const older = withOlderIphoneSession
      ? login({ deviceId: "dev-iphone", network: HOME, at: "2026-03-15T09:00:00+04:00" }).session
      : undefined;
    reportSimSwap({ swappedAt: "2026-03-15T08:40:00+04:00", at: "2026-03-15T09:00:30+04:00" });
    const suspicious = login({ deviceId: "dev-iphone", network: ABROAD, at: "2026-03-15T09:01:00+04:00" }).session;
    const { beneficiary } = addBeneficiary(suspicious.token, {
      name: "Fast Cash FZE",
      iban: "AE00 DEMO 9999 0000 0000 001",
      at: "2026-03-15T09:02:00+04:00",
    });
    const paid = requestTransfer(suspicious.token, { beneficiaryId: beneficiary.id, amount: 5000, at: "2026-03-15T09:03:00+04:00" });
    const verification = getSnapshot().verifications.find((v) => v.paymentId === paid.payment.id)!;
    return { older, suspicious, paid, verification };
  }

  it("is UNDELIVERABLE when the only trusted session is the suspicious one, and the payment stays held", async () => {
    const { suspicious, paid, verification } = trustedDeviceTakeover(false);
    expect(paid.risk.score).toBe(65);
    expect(paid.payment.status).toBe("HELD");
    expect(verification.status).toBe("UNDELIVERABLE");
    expect(verification.targetSessionId).toBeNull();

    let error: unknown;
    try {
      respondToVerification(suspicious.token, verification.id, { response: "CONFIRM" });
    } catch (e) {
      error = e;
    }
    expect((error as DomainError).code).toBe("NOT_TRUSTED_CHANNEL");
    await whenIdle();
    const s = getSnapshot();
    expect(s.payments.find((p) => p.id === paid.payment.id)?.status).toBe("HELD");
    expect(s.customer.balance).toBe(92000);
  });

  it("targets another trusted session when there is one", async () => {
    const { older, suspicious, verification } = trustedDeviceTakeover(true);
    expect(verification.status).toBe("PENDING");
    expect(verification.targetSessionId).toBe(older!.id);
    expect(verification.targetSessionId).not.toBe(suspicious.id);
    await whenIdle();
  });

  it("the policy gateway refuses a proof from the suspicious session itself", async () => {
    const { suspicious, paid, verification } = trustedDeviceTakeover(false);
    // Forge a verification that targets the suspicious session, as the old code did.
    const stored = getState().verifications.find((v) => v.id === verification.id)!;
    stored.status = "PENDING";
    stored.targetSessionId = suspicious.id;
    stored.targetDeviceId = suspicious.deviceId;
    const proof = { verificationId: verification.id, sessionId: suspicious.id };
    expect(releasePayment("customer-verification", paid.payment.id, proof).allowed).toBe(false);
    expect(cancelPayment("customer-verification", paid.payment.id, proof).allowed).toBe(false);
    expect(getSnapshot().payments.find((p) => p.id === paid.payment.id)?.status).toBe("HELD");
    await whenIdle();
  });
});

describe("DENY closes every open payment of the suspicious session", () => {
  it("cancels the other held payments, denies their verifications and confirms their incidents", async () => {
    const iphone = login({
      deviceId: "dev-iphone",
      network: { ip: "10.0.0.2", city: "Dubai", country: "AE" },
      at: "2026-03-15T09:50:00+04:00",
    }).session;
    const attacker = login({
      deviceId: "dev-android-x",
      device: { label: "Samsung Galaxy A54", platform: "Android" },
      network: { ip: "10.88.14.207", city: "Dubai", country: "AE" },
      at: "2026-03-15T10:00:00+04:00",
    }).session;
    reportSimSwap({ swappedAt: "2026-03-15T09:30:00+04:00", at: "2026-03-15T10:01:00+04:00" });
    const first = requestTransfer(attacker.token, { beneficiaryId: "ben-alnoor", amount: 20000, at: "2026-03-15T10:05:00+04:00" });
    const second = requestTransfer(attacker.token, { beneficiaryId: "ben-alnoor", amount: 20000, at: "2026-03-15T10:06:00+04:00" });
    expect(first.payment.status).toBe("HELD");
    expect(second.payment.status).toBe("HELD");
    await whenIdle();

    let s = getSnapshot();
    const v1 = s.verifications.find((v) => v.paymentId === first.payment.id)!;
    const v2 = s.verifications.find((v) => v.paymentId === second.payment.id)!;
    expect(v1.targetSessionId).toBe(iphone.id);

    respondToVerification(iphone.token, v1.id, { response: "DENY" });
    await whenIdle();
    s = getSnapshot();
    expect(s.sessions.find((x) => x.id === attacker.id)?.status).toBe("REVOKED");
    for (const id of [first.payment.id, second.payment.id]) {
      expect(s.payments.find((p) => p.id === id)?.status, id).toBe("CANCELLED");
      expect(s.incidents.find((i) => i.paymentId === id)?.status, id).toBe("CONFIRMED_ATO");
    }
    expect(s.verifications.find((v) => v.id === v2.id)?.status).toBe("DENIED");
    const secondAudit = s.audit.filter((e) => e.paymentId === second.payment.id).map((e) => e.action);
    expect(secondAudit).toEqual(expect.arrayContaining(["PAYMENT_CANCELLED", "INCIDENT_CONFIRMED_ATO", "VERIFICATION_DENIED"]));

    let error: unknown;
    try {
      respondToVerification(iphone.token, v2.id, { response: "CONFIRM" });
    } catch (e) {
      error = e;
    }
    expect((error as DomainError).code).toBe("CONFLICT");
    s = getSnapshot();
    expect(s.payments.find((p) => p.id === second.payment.id)?.status).toBe("CANCELLED");
    expect(s.customer.balance).toBe(92000);
  });
});
