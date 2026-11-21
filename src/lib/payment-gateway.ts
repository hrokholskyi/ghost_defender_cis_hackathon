/**
 * Payment Gateway. Decides every transfer from the deterministic Risk Engine
 * BEFORE any debit. Non-ALLOW decisions never move money; they start an
 * asynchronous investigation that can only tighten protection.
 */
import { audit } from "@/lib/audit";
import {
  assessSession,
  authenticate,
  debitAndSettle,
  findBeneficiary,
  findPayment,
} from "@/lib/bank";
import { advanceClock, now } from "@/lib/clock";
import { RISK_LEVEL_LABELS, RISK_THRESHOLDS } from "@/lib/config";
import { DomainError } from "@/lib/errors";
import { formatAed } from "@/lib/format";
import { startInvestigation } from "@/lib/investigations";
import { holdPayment, restrictSession } from "@/lib/policy-gateway";
import { firstCrossing } from "@/lib/risk-engine";
import { parseInput, transferSchema } from "@/lib/schemas";
import { getState, nextId, touch } from "@/lib/store";
import type { z } from "zod";
import type { Payment, PaymentResponse, RiskAssessment, RiskLevel, RiskSignalId, Session } from "@/lib/types";
import { createVerification } from "@/lib/verification";

function baseReasons(risk: RiskAssessment): string[] {
  return risk.signals.map((s) => `${s.label}: ${s.evidence} (+${s.points})`);
}

/**
 * Text and audit data for the threshold that triggered a hold (High) or a
 * restriction (Critical): the first signal, in RISK_SIGNAL_ORDER, whose
 * running score reached it. Falls back to the final score if none did.
 */
export function crossingRecord(
  risk: RiskAssessment,
  threshold: number,
): { text: string; data: { score: number; level: RiskLevel; signal: RiskSignalId | null } } {
  const crossing = firstCrossing(risk, threshold);
  if (!crossing) {
    return {
      text: `Risk score ${risk.score} (${RISK_LEVEL_LABELS[risk.level]}).`,
      data: { score: risk.score, level: risk.level, signal: null },
    };
  }
  return {
    text: `Running score reached ${crossing.score} (${RISK_LEVEL_LABELS[crossing.level]}) with signal ${crossing.signalLabel}.`,
    data: { score: crossing.score, level: crossing.level, signal: crossing.signal },
  };
}

/** One field of the raw body, checked with its transfer schema, or undefined when absent or invalid. */
function validField<K extends keyof typeof transferSchema.shape>(raw: unknown, key: K) {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
  if (value === undefined) return undefined;
  const parsed = transferSchema.shape[key].safeParse(value);
  return parsed.success ? (parsed.data as z.output<(typeof transferSchema.shape)[K]>) : undefined;
}

function recordRejected(session: Session, raw: unknown, reason: string, data: Record<string, unknown>): Payment {
  const risk = getState().risk[session.id];
  const at = now();
  const beneficiaryId = validField(raw, "beneficiaryId");
  const payment: Payment = {
    id: nextId("pay"),
    sessionId: session.id,
    // Only validated values are stored; anything else is dropped.
    beneficiaryId: beneficiaryId && findBeneficiary(beneficiaryId) ? beneficiaryId : "",
    amount: validField(raw, "amount") ?? 0,
    currency: "AED",
    status: "REJECTED",
    requestedAt: at,
    decidedAt: at,
    riskScore: risk?.score ?? 0,
    riskLevel: risk?.level ?? "LOW",
    action: risk?.action ?? "ALLOW",
    reasons: [reason],
    historical: false,
  };
  getState().payments.push(payment);
  touch();
  audit({
    actor: "payment-gateway",
    action: "PAYMENT_REJECTED",
    sessionId: session.id,
    paymentId: payment.id,
    detail: payment.amount > 0 ? `Transfer of ${formatAed(payment.amount)} refused: ${reason}` : `Transfer refused: ${reason}`,
    data,
  });
  return payment;
}

/** POST /api/payments. `raw` is validated here, after the session checks. */
export function requestTransfer(token: string | null, raw: unknown): PaymentResponse {
  const session = authenticate(token);
  const state = getState();

  if (session.status === "RESTRICTED" || session.status === "REVOKED") {
    // The body is not validated as a whole here, so the clock only moves for an `at` that passes its own schema.
    const at = validField(raw, "at");
    if (at !== undefined) advanceClock(at);
    const code = session.status === "RESTRICTED" ? "SESSION_RESTRICTED" : "SESSION_REVOKED";
    const reason = `this session is ${session.status === "RESTRICTED" ? "restricted" : "revoked"}.`;
    recordRejected(session, raw, reason, { code, sessionId: session.id, sessionStatus: session.status });
    throw new DomainError(code, `Transfer refused: ${reason}`);
  }

  const input = parseInput(transferSchema, raw);
  advanceClock(input.at);
  const beneficiary = findBeneficiary(input.beneficiaryId);
  if (!beneficiary) throw new DomainError("NOT_FOUND", `Beneficiary ${input.beneficiaryId} not found`);

  const paymentId = nextId("pay");
  const requestedAt = now();
  audit({
    actor: "customer",
    action: "PAYMENT_REQUESTED",
    sessionId: session.id,
    paymentId,
    detail: `Transfer of ${formatAed(input.amount)} to ${beneficiary.name} requested`,
    data: { amount: input.amount, beneficiaryId: beneficiary.id },
  });

  const risk = assessSession(
    session,
    "Transfer requested",
    {
      amount: input.amount,
      beneficiaryName: beneficiary.name,
      beneficiarySettledCount: beneficiary.settledPaymentCount,
      beneficiaryCreatedInSession: beneficiary.createdBySessionId === session.id,
      requestedAt,
    },
    paymentId,
  );

  const payment: Payment = {
    id: paymentId,
    sessionId: session.id,
    beneficiaryId: beneficiary.id,
    amount: input.amount,
    currency: "AED",
    // No-debit state until the decision below is applied.
    status: "PENDING_VERIFICATION",
    requestedAt,
    decidedAt: now(),
    riskScore: risk.score,
    riskLevel: risk.level,
    action: risk.action,
    reasons: [],
    historical: false,
  };

  if (risk.action === "ALLOW") {
    if (input.amount > state.customer.balance) {
      payment.status = "REJECTED";
      payment.reasons = [`Insufficient funds: balance ${formatAed(state.customer.balance)}`];
      state.payments.push(payment);
      touch();
      audit({
        actor: "payment-gateway",
        action: "PAYMENT_REJECTED",
        sessionId: session.id,
        paymentId,
        detail: `Transfer of ${formatAed(input.amount)} refused: insufficient funds`,
      });
      throw new DomainError(
        "INSUFFICIENT_FUNDS",
        `Insufficient funds: balance ${formatAed(state.customer.balance)}, requested ${formatAed(input.amount)}`,
      );
    }
    payment.reasons = [`Risk ${risk.score} (${risk.level}): allowed and monitored`, ...baseReasons(risk)];
    state.payments.push(payment);
    touch();
    debitAndSettle(payment, "payment-gateway", `Risk ${risk.score} (${risk.level}), allowed`);
    return { payment, risk, balance: state.customer.balance };
  }

  state.payments.push(payment);
  touch();

  if (risk.action === "STEP_UP") {
    payment.reasons = [
      `Risk ${risk.score} (${risk.level}): waiting for confirmation on a trusted device. Nothing debited`,
      ...baseReasons(risk),
    ];
    audit({
      actor: "payment-gateway",
      action: "PAYMENT_PENDING_VERIFICATION",
      sessionId: session.id,
      paymentId,
      detail: `${formatAed(payment.amount)} waits for step-up verification. Nothing debited`,
    });
  } else {
    // One assessment, one decision. The record names the point where the running score
    // crossed each threshold, so the staged story (held at 75, restricted at 90) is literally true.
    payment.reasons = [`Risk ${risk.score} (${risk.level}): held before debit`, ...baseReasons(risk)];
    const hold = crossingRecord(risk, RISK_THRESHOLDS.high);
    holdPayment("payment-gateway", paymentId, hold.text, hold.data);
    if (risk.action === "HOLD_AND_RESTRICT") {
      const restrict = crossingRecord(risk, RISK_THRESHOLDS.critical);
      restrictSession("payment-gateway", session.id, restrict.text, restrict.data);
      payment.reasons.push(`Session restricted by payment-gateway: ${restrict.text}`);
    }
  }

  createVerification(payment, beneficiary.name);
  startInvestigation(payment, risk, risk.action, beneficiary.name);
  return { payment, risk, balance: state.customer.balance };
}

/**
 * POST /api/payments/{id}/execute. A retry never bypasses a hold and never
 * debits twice. Every refused retry is audited as HOLD_BYPASS_ATTEMPT.
 */
export function executePayment(token: string | null, paymentId: string): PaymentResponse {
  const session = authenticate(token);
  const state = getState();
  const payment = findPayment(paymentId);
  if (!payment || payment.sessionId !== session.id) {
    throw new DomainError("NOT_FOUND", `Payment ${paymentId} not found for this session`);
  }

  /** `reason` is plain text without ids; ids and statuses go into the audit data. */
  const refuse = (code: "SESSION_RESTRICTED" | "SESSION_REVOKED" | "PAYMENT_HELD" | "CONFLICT", reason: string) => {
    audit({
      actor: "payment-gateway",
      action: "HOLD_BYPASS_ATTEMPT",
      sessionId: session.id,
      paymentId,
      detail: `Retry of ${formatAed(payment.amount)} refused: ${reason}`,
      data: { code, sessionId: session.id, paymentStatus: payment.status, sessionStatus: session.status },
    });
    return new DomainError(code, `Retry refused: ${reason}`);
  };

  if (session.status === "RESTRICTED") throw refuse("SESSION_RESTRICTED", "this session is restricted.");
  if (session.status === "REVOKED") throw refuse("SESSION_REVOKED", "this session is revoked.");

  const risk = state.risk[session.id];
  switch (payment.status) {
    case "SETTLED":
      return { payment, risk, balance: state.customer.balance };
    case "HELD":
      throw refuse("PAYMENT_HELD", "this payment is held. Only the customer's trusted device can release it.");
    case "PENDING_VERIFICATION":
      throw refuse("PAYMENT_HELD", "this payment waits for confirmation. Only the customer's trusted device can release it.");
    case "CANCELLED":
      throw refuse("CONFLICT", "this payment was cancelled and cannot be executed.");
    case "REJECTED":
      throw refuse("CONFLICT", "this payment was refused and cannot be executed.");
  }
}
