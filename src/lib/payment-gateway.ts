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
import { DomainError } from "@/lib/errors";
import { formatAed } from "@/lib/format";
import { startInvestigation } from "@/lib/investigations";
import { holdPayment, restrictSession } from "@/lib/policy-gateway";
import { parseInput, transferSchema } from "@/lib/schemas";
import { getState, nextId, touch } from "@/lib/store";
import type { z } from "zod";
import type { Payment, PaymentResponse, RiskAssessment, Session } from "@/lib/types";
import { createVerification } from "@/lib/verification";

function baseReasons(risk: RiskAssessment): string[] {
  return risk.signals.map((s) => `${s.label}: ${s.evidence} (+${s.points})`);
}

/** One field of the raw body, checked with its transfer schema, or undefined when absent or invalid. */
function validField<K extends keyof typeof transferSchema.shape>(raw: unknown, key: K) {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
  if (value === undefined) return undefined;
  const parsed = transferSchema.shape[key].safeParse(value);
  return parsed.success ? (parsed.data as z.output<(typeof transferSchema.shape)[K]>) : undefined;
}

function recordRejected(session: Session, raw: unknown, reason: string): Payment {
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
    const reason = `session ${session.id} is ${session.status}`;
    recordRejected(session, raw, reason);
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
    payment.reasons = [`Risk ${risk.score} (${risk.level}): held before debit`, ...baseReasons(risk)];
    holdPayment("payment-gateway", paymentId, `Risk ${risk.score} (${risk.level}) -> ${risk.action}`);
    if (risk.action === "HOLD_AND_RESTRICT") {
      restrictSession(
        "payment-gateway",
        session.id,
        `Risk ${risk.score} (${risk.level}) on a transfer of ${formatAed(payment.amount)}`,
      );
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

  const refuse = (code: "SESSION_RESTRICTED" | "SESSION_REVOKED" | "PAYMENT_HELD" | "CONFLICT", message: string) => {
    audit({
      actor: "payment-gateway",
      action: "HOLD_BYPASS_ATTEMPT",
      sessionId: session.id,
      paymentId,
      detail: `Retry of ${formatAed(payment.amount)} refused (${code}): ${message}`,
      data: { code, paymentStatus: payment.status, sessionStatus: session.status },
    });
    return new DomainError(code, message);
  };

  if (session.status === "RESTRICTED") throw refuse("SESSION_RESTRICTED", `Session ${session.id} is restricted`);
  if (session.status === "REVOKED") throw refuse("SESSION_REVOKED", `Session ${session.id} was revoked`);

  const risk = state.risk[session.id];
  switch (payment.status) {
    case "SETTLED":
      return { payment, risk, balance: state.customer.balance };
    case "HELD":
    case "PENDING_VERIFICATION":
      throw refuse(
        "PAYMENT_HELD",
        `Payment ${payment.id} is ${payment.status}. Only the customer's trusted device can release it`,
      );
    case "CANCELLED":
    case "REJECTED":
      throw refuse("CONFLICT", `Payment ${payment.id} is ${payment.status} and cannot be executed`);
  }
}
