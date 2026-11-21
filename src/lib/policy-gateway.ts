/**
 * Policy Gateway: the only code path that changes a payment hold or a session
 * restriction.
 *
 * Permission matrix, enforced in code:
 * - risk-engine, payment-gateway, ai-investigator: may only tighten (hold, restrict).
 * - customer-verification: may release, cancel, revoke and lift, and only with
 *   proof of a valid trusted session that is answering a pending verification.
 * - everyone else: denied.
 *
 * Every allowed and denied call is written to the audit log. There is no
 * function that accepts free text to release anything.
 */
import { audit } from "@/lib/audit";
import { debitAndSettle, findDevice, findPayment, findSession } from "@/lib/bank";
import { now } from "@/lib/clock";
import { formatAed } from "@/lib/format";
import { getState, touch } from "@/lib/store";
import type { Actor, Payment, Session } from "@/lib/types";

/** Proof that the call comes from a trusted session answering a verification. */
export interface TrustedSessionProof {
  verificationId: string;
  /** Session that answered. Must be the verification's target. */
  sessionId: string;
}

export interface PolicyDecision {
  allowed: boolean;
  /** True when the state actually changed. */
  changed: boolean;
  reason: string;
}

type PolicyOperation =
  | "HOLD_PAYMENT"
  | "RESTRICT_SESSION"
  | "RELEASE_PAYMENT"
  | "CANCEL_PAYMENT"
  | "REVOKE_SESSION"
  | "LIFT_RESTRICTION";

const TIGHTENING_ACTORS: readonly Actor[] = ["risk-engine", "payment-gateway", "ai-investigator"];
const LOOSENING_ACTORS: readonly Actor[] = ["customer-verification"];

const PERMISSIONS: Record<PolicyOperation, readonly Actor[]> = {
  HOLD_PAYMENT: TIGHTENING_ACTORS,
  RESTRICT_SESSION: TIGHTENING_ACTORS,
  RELEASE_PAYMENT: LOOSENING_ACTORS,
  CANCEL_PAYMENT: LOOSENING_ACTORS,
  REVOKE_SESSION: LOOSENING_ACTORS,
  LIFT_RESTRICTION: LOOSENING_ACTORS,
};

interface Target {
  sessionId?: string;
  paymentId?: string;
}

function deny(actor: Actor, operation: PolicyOperation, target: Target, reason: string): PolicyDecision {
  audit({
    actor: "policy-gateway",
    action: "POLICY_DENIED",
    sessionId: target.sessionId,
    paymentId: target.paymentId,
    detail: `Denied ${operation} requested by ${actor}: ${reason}`,
    data: { requestedBy: actor, operation },
  });
  return { allowed: false, changed: false, reason };
}

function unchanged(actor: Actor, operation: PolicyOperation, target: Target, reason: string): PolicyDecision {
  audit({
    actor: "policy-gateway",
    action: "POLICY_NO_CHANGE",
    sessionId: target.sessionId,
    paymentId: target.paymentId,
    detail: `${operation} requested by ${actor} changed nothing: ${reason}`,
    data: { requestedBy: actor, operation },
  });
  return { allowed: true, changed: false, reason };
}

function permitted(actor: Actor, operation: PolicyOperation): boolean {
  return PERMISSIONS[operation].includes(actor);
}

/**
 * Validates the proof against the store: a PENDING verification whose target
 * is the answering session, which must be ACTIVE and on a trusted device.
 * The verification must concern the payment or session being changed.
 */
function checkProof(proof: TrustedSessionProof | undefined, target: Target): string | null {
  if (!proof) return "no proof of a trusted session";
  const verification = getState().verifications.find((v) => v.id === proof.verificationId);
  if (!verification) return `verification ${proof.verificationId} not found`;
  if (verification.status !== "PENDING") return `verification ${verification.id} is ${verification.status}`;
  if (verification.targetSessionId === null || verification.targetSessionId !== proof.sessionId) {
    return `session ${proof.sessionId} is not the target of verification ${verification.id}`;
  }
  const session = findSession(proof.sessionId);
  if (!session || session.status !== "ACTIVE") return `session ${proof.sessionId} is not active`;
  if (findDevice(session.deviceId)?.trusted !== true) return `session ${proof.sessionId} is not on a trusted device`;
  if (target.paymentId && verification.paymentId !== target.paymentId) {
    return `verification ${verification.id} does not cover payment ${target.paymentId}`;
  }
  if (!target.paymentId && target.sessionId && verification.suspiciousSessionId !== target.sessionId) {
    return `verification ${verification.id} does not cover session ${target.sessionId}`;
  }
  return null;
}

function authorize(
  actor: Actor,
  operation: PolicyOperation,
  target: Target,
  proof?: TrustedSessionProof,
): PolicyDecision | null {
  if (!permitted(actor, operation)) {
    return deny(actor, operation, target, `${actor} is not allowed to ${operation.toLowerCase().replace("_", " ")}`);
  }
  if (LOOSENING_ACTORS.includes(actor)) {
    const problem = checkProof(proof, target);
    if (problem) return deny(actor, operation, target, problem);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tightening
// ---------------------------------------------------------------------------

/** PENDING_VERIFICATION -> HELD. No debit. */
export function holdPayment(actor: Actor, paymentId: string, reason: string): PolicyDecision {
  const payment = findPayment(paymentId);
  const target = { paymentId, sessionId: payment?.sessionId };
  const denied = authorize(actor, "HOLD_PAYMENT", target);
  if (denied) return denied;
  if (!payment) return unchanged(actor, "HOLD_PAYMENT", target, "payment not found");
  if (payment.status === "HELD") return unchanged(actor, "HOLD_PAYMENT", target, "payment is already held");
  if (payment.status !== "PENDING_VERIFICATION") {
    return unchanged(actor, "HOLD_PAYMENT", target, `payment is ${payment.status}`);
  }
  payment.status = "HELD";
  payment.reasons.push(`Held by ${actor}: ${reason}`);
  touch();
  audit({
    actor,
    action: "PAYMENT_HELD",
    sessionId: payment.sessionId,
    paymentId,
    detail: `${formatAed(payment.amount)} held before debit. ${reason}`,
    data: { amount: payment.amount },
  });
  return { allowed: true, changed: true, reason };
}

/** ACTIVE -> RESTRICTED. */
export function restrictSession(actor: Actor, sessionId: string, reason: string): PolicyDecision {
  const target = { sessionId };
  const denied = authorize(actor, "RESTRICT_SESSION", target);
  if (denied) return denied;
  const session = findSession(sessionId);
  if (!session) return unchanged(actor, "RESTRICT_SESSION", target, "session not found");
  if (session.status !== "ACTIVE") return unchanged(actor, "RESTRICT_SESSION", target, `session is ${session.status}`);
  session.status = "RESTRICTED";
  session.restrictedAt = now();
  session.restrictionReason = reason;
  touch();
  audit({
    actor,
    action: "SESSION_RESTRICTED",
    sessionId,
    detail: `Session restricted: no payments or beneficiary changes. ${reason}`,
  });
  return { allowed: true, changed: true, reason };
}

// ---------------------------------------------------------------------------
// Loosening (customer-verification with trusted-session proof only)
// ---------------------------------------------------------------------------

function isOpen(payment: Payment): boolean {
  return payment.status === "HELD" || payment.status === "PENDING_VERIFICATION";
}

/** HELD or PENDING_VERIFICATION -> SETTLED, with the debit. Throws INSUFFICIENT_FUNDS. */
export function releasePayment(actor: Actor, paymentId: string, proof?: TrustedSessionProof): PolicyDecision {
  const payment = findPayment(paymentId);
  const target = { paymentId, sessionId: payment?.sessionId };
  const denied = authorize(actor, "RELEASE_PAYMENT", target, proof);
  if (denied) return denied;
  if (!payment || !isOpen(payment)) {
    return unchanged(actor, "RELEASE_PAYMENT", target, payment ? `payment is ${payment.status}` : "payment not found");
  }
  audit({
    actor,
    action: "PAYMENT_RELEASED",
    sessionId: payment.sessionId,
    paymentId,
    detail: `Customer confirmed the payment on a trusted device (verification ${proof?.verificationId})`,
  });
  debitAndSettle(payment, "payment-gateway", "Released after confirmation on a trusted device");
  return { allowed: true, changed: true, reason: "confirmed on a trusted device" };
}

/** HELD or PENDING_VERIFICATION -> CANCELLED. No debit. */
export function cancelPayment(actor: Actor, paymentId: string, proof?: TrustedSessionProof): PolicyDecision {
  const payment = findPayment(paymentId);
  const target = { paymentId, sessionId: payment?.sessionId };
  const denied = authorize(actor, "CANCEL_PAYMENT", target, proof);
  if (denied) return denied;
  if (!payment || !isOpen(payment)) {
    return unchanged(actor, "CANCEL_PAYMENT", target, payment ? `payment is ${payment.status}` : "payment not found");
  }
  payment.status = "CANCELLED";
  payment.reasons.push("Cancelled: the customer denied it on a trusted device");
  touch();
  audit({
    actor,
    action: "PAYMENT_CANCELLED",
    sessionId: payment.sessionId,
    paymentId,
    detail: `${formatAed(payment.amount)} cancelled. The customer denied it on a trusted device. Nothing was debited`,
  });
  return { allowed: true, changed: true, reason: "denied on a trusted device" };
}

function sessionTarget(session: Session | undefined, sessionId: string): Target {
  return { sessionId: session?.id ?? sessionId };
}

/** Any status -> REVOKED. */
export function revokeSession(actor: Actor, sessionId: string, proof?: TrustedSessionProof): PolicyDecision {
  const session = findSession(sessionId);
  const target = sessionTarget(session, sessionId);
  const denied = authorize(actor, "REVOKE_SESSION", target, proof);
  if (denied) return denied;
  if (!session) return unchanged(actor, "REVOKE_SESSION", target, "session not found");
  if (session.status === "REVOKED") return unchanged(actor, "REVOKE_SESSION", target, "session is already revoked");
  if (proof && proof.sessionId === sessionId) {
    return deny(actor, "REVOKE_SESSION", target, "a session cannot revoke itself through verification");
  }
  session.status = "REVOKED";
  touch();
  audit({
    actor,
    action: "SESSION_REVOKED",
    sessionId,
    detail: "Session revoked after the customer denied the payment on a trusted device",
  });
  return { allowed: true, changed: true, reason: "denied on a trusted device" };
}

/** RESTRICTED -> ACTIVE. */
export function liftRestriction(actor: Actor, sessionId: string, proof?: TrustedSessionProof): PolicyDecision {
  const session = findSession(sessionId);
  const target = sessionTarget(session, sessionId);
  const denied = authorize(actor, "LIFT_RESTRICTION", target, proof);
  if (denied) return denied;
  if (!session || session.status !== "RESTRICTED") {
    return unchanged(actor, "LIFT_RESTRICTION", target, session ? `session is ${session.status}` : "session not found");
  }
  session.status = "ACTIVE";
  delete session.restrictedAt;
  delete session.restrictionReason;
  touch();
  audit({
    actor,
    action: "SESSION_RESTRICTION_LIFTED",
    sessionId,
    detail: "Restriction lifted after the customer confirmed the payment on a trusted device",
  });
  return { allowed: true, changed: true, reason: "confirmed on a trusted device" };
}
