/**
 * Independent verification channel: a push to the customer's trusted device.
 * Never SMS, because the SIM may have just been swapped.
 */
import { audit } from "@/lib/audit";
import {
  assertFunds,
  authenticate,
  findDevice,
  findSession,
  isTrustedActiveSession,
  requirePayment,
} from "@/lib/bank";
import { now } from "@/lib/clock";
import { DomainError } from "@/lib/errors";
import { formatAed } from "@/lib/format";
import { findIncidentForPayment, openIncident, resolveIncident } from "@/lib/incidents";
import {
  cancelPayment,
  liftRestriction,
  releasePayment,
  revokeSession,
  type TrustedSessionProof,
} from "@/lib/policy-gateway";
import { getState, nextId, touch } from "@/lib/store";
import type {
  Payment,
  Session,
  VerificationRequest,
  VerificationResponse,
  VerificationResponseRequest,
} from "@/lib/types";
import { parseIso } from "@/lib/time";

/**
 * Most recent ACTIVE session on a trusted device, other than the session that
 * requested the payment, or null. The requesting session is never asked to
 * confirm its own payment, even when it runs on a trusted device.
 */
export function findTrustedTargetSession(requestingSessionId: string): Session | null {
  const candidates = getState().sessions.filter((s) => s.id !== requestingSessionId && isTrustedActiveSession(s));
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, s) => (parseIso(s.createdAt) > parseIso(latest.createdAt) ? s : latest));
}

/** Creates the verification request for a HELD or PENDING_VERIFICATION payment. */
export function createVerification(payment: Payment, beneficiaryName: string): VerificationRequest {
  const state = getState();
  const target = findTrustedTargetSession(payment.sessionId);
  const device = target ? findDevice(target.deviceId) : undefined;
  const verification: VerificationRequest = {
    id: nextId("ver"),
    paymentId: payment.id,
    suspiciousSessionId: payment.sessionId,
    channel: "TRUSTED_DEVICE_PUSH",
    targetDeviceId: target?.deviceId ?? null,
    targetSessionId: target?.id ?? null,
    status: target ? "PENDING" : "UNDELIVERABLE",
    message: `Did you just send ${formatAed(payment.amount)} to ${beneficiaryName}? Confirm only if it was you.`,
    createdAt: now(),
  };
  state.verifications.push(verification);
  touch();
  if (target) {
    audit({
      actor: "customer-verification",
      action: "VERIFICATION_SENT",
      sessionId: payment.sessionId,
      paymentId: payment.id,
      detail: `Push sent to trusted device ${device?.label ?? target.deviceId} (session ${target.id}). Not by SMS`,
      data: { verificationId: verification.id, targetSessionId: target.id },
    });
  } else {
    audit({
      actor: "customer-verification",
      action: "VERIFICATION_UNDELIVERABLE",
      sessionId: payment.sessionId,
      paymentId: payment.id,
      detail: "No other active session on a trusted device. The payment stays held until the customer is reached",
      data: { verificationId: verification.id },
    });
  }
  return verification;
}

/**
 * After a DENY, every other open payment of the suspicious session is part of
 * the same takeover: cancel it through the Policy Gateway, close its
 * verifications as DENIED and confirm its incident. Runs while `denied` is
 * still PENDING, because the proof refers to it.
 */
function closeOtherOpenPayments(denied: VerificationRequest, proof: TrustedSessionProof): void {
  const state = getState();
  const others = state.payments.filter(
    (p) =>
      p.id !== denied.paymentId &&
      p.sessionId === denied.suspiciousSessionId &&
      (p.status === "HELD" || p.status === "PENDING_VERIFICATION"),
  );
  for (const other of others) {
    if (!cancelPayment("customer-verification", other.id, proof).changed) continue;
    const at = now();
    for (const v of state.verifications) {
      if (v.paymentId !== other.id || (v.status !== "PENDING" && v.status !== "UNDELIVERABLE")) continue;
      v.status = "DENIED";
      v.respondedAt = at;
      touch();
      audit({
        actor: "customer-verification",
        action: "VERIFICATION_DENIED",
        sessionId: other.sessionId,
        paymentId: other.id,
        detail: `${v.id} closed as denied: the customer denied ${denied.id} for the same session on a trusted device`,
        data: { verificationId: v.id, deniedVerificationId: denied.id },
      });
    }
    const incident =
      findIncidentForPayment(other.id) ??
      openIncident("customer-verification", other.sessionId, other.id, {
        title: "Account takeover reported by the customer",
        severity: other.riskLevel,
        reasons: [...other.reasons],
      });
    if (incident.status === "OPEN") {
      resolveIncident(
        "customer-verification",
        incident,
        "CONFIRMED_ATO",
        `The customer denied ${denied.paymentId} from the same session on a trusted device. Account takeover confirmed`,
      );
    }
  }
}

export function respondToVerification(
  token: string | null,
  verificationId: string,
  input: VerificationResponseRequest,
): VerificationResponse {
  const state = getState();
  const verification = state.verifications.find((v) => v.id === verificationId);
  if (!verification) throw new DomainError("NOT_FOUND", `Verification ${verificationId} not found`);
  const session = authenticate(token);

  if (verification.targetSessionId !== session.id || !isTrustedActiveSession(session)) {
    audit({
      actor: "customer-verification",
      action: "VERIFICATION_UNTRUSTED_RESPONSE",
      sessionId: session.id,
      paymentId: verification.paymentId,
      detail: `Answer to ${verification.id} from session ${session.id} refused: not the trusted target channel`,
      data: { verificationId: verification.id, response: input.response },
    });
    throw new DomainError(
      "NOT_TRUSTED_CHANNEL",
      "Only the customer's trusted device that received the push can answer this verification",
    );
  }
  if (verification.status !== "PENDING") {
    throw new DomainError("CONFLICT", `Verification ${verification.id} is already ${verification.status}`);
  }

  const payment = requirePayment(verification.paymentId);
  const proof: TrustedSessionProof = { verificationId: verification.id, sessionId: session.id };
  const suspicious = findSession(verification.suspiciousSessionId);

  if (input.response === "DENY") {
    cancelPayment("customer-verification", payment.id, proof);
    if (suspicious && suspicious.id !== session.id) {
      revokeSession("customer-verification", suspicious.id, proof);
    }
    const incident =
      findIncidentForPayment(payment.id) ??
      openIncident("customer-verification", payment.sessionId, payment.id, {
        title: "Account takeover reported by the customer",
        severity: payment.riskLevel,
        reasons: [...payment.reasons],
      });
    resolveIncident(
      "customer-verification",
      incident,
      "CONFIRMED_ATO",
      "The customer denied the payment on a trusted device. Account takeover confirmed",
    );
    closeOtherOpenPayments(verification, proof);
    audit({
      actor: "bank-simulator",
      action: "SECURE_RECOVERY_STARTED",
      sessionId: payment.sessionId,
      paymentId: payment.id,
      detail: "Stub: secure recovery started (reset credentials, re-bind phone number, contact the customer)",
    });
    verification.status = "DENIED";
  } else {
    assertFunds(payment.amount);
    releasePayment("customer-verification", payment.id, proof);
    if (suspicious && suspicious.status === "RESTRICTED") {
      liftRestriction("customer-verification", suspicious.id, proof);
    }
    const incident = findIncidentForPayment(payment.id);
    if (incident && incident.status === "OPEN") {
      resolveIncident(
        "customer-verification",
        incident,
        "RESOLVED_LEGITIMATE",
        "The customer confirmed the payment on a trusted device",
      );
    }
    verification.status = "CONFIRMED";
  }

  verification.respondedAt = now();
  touch();
  audit({
    actor: "customer-verification",
    action: verification.status === "DENIED" ? "VERIFICATION_DENIED" : "VERIFICATION_CONFIRMED",
    sessionId: session.id,
    paymentId: payment.id,
    detail: `Customer answered ${verification.id} with ${input.response} on a trusted device`,
    data: { verificationId: verification.id },
  });

  return { verification, payment, balance: state.customer.balance };
}
