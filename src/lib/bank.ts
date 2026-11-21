/**
 * Bank simulator: sessions, devices, beneficiaries, SIM signal, ledger.
 * All data is synthetic. Login simulates a successful password + OTP check.
 */
import { randomUUID } from "node:crypto";
import { audit } from "@/lib/audit";
import { advanceClock, now } from "@/lib/clock";
import { DomainError } from "@/lib/errors";
import { formatAed } from "@/lib/format";
import { assessRisk, median, type RiskFacts, type RiskPaymentFacts } from "@/lib/risk-engine";
import { getState, nextId, touch } from "@/lib/store";
import type {
  Actor,
  AddBeneficiaryRequest,
  Beneficiary,
  Device,
  LoginRequest,
  LoginResponse,
  Payment,
  RiskAssessment,
  Session,
  SimStatus,
  SimSwapRequest,
} from "@/lib/types";
import { clockLabel, normalizeIso } from "@/lib/time";

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findSession(id: string): Session | undefined {
  return getState().sessions.find((s) => s.id === id);
}

export function findDevice(id: string): Device | undefined {
  return getState().devices.find((d) => d.id === id);
}

export function findBeneficiary(id: string): Beneficiary | undefined {
  return getState().beneficiaries.find((b) => b.id === id);
}

export function findPayment(id: string): Payment | undefined {
  return getState().payments.find((p) => p.id === id);
}

export function requireSession(id: string): Session {
  const session = findSession(id);
  if (!session) throw new DomainError("NOT_FOUND", `Session ${id} not found`);
  return session;
}

export function requirePayment(id: string): Payment {
  const payment = findPayment(id);
  if (!payment) throw new DomainError("NOT_FOUND", `Payment ${id} not found`);
  return payment;
}

/** Resolves a bearer token to its session, any status. */
export function authenticate(token: string | null | undefined): Session {
  if (!token) throw new DomainError("UNAUTHENTICATED", "Missing bearer token");
  const session = getState().sessions.find((s) => s.token === token);
  if (!session) throw new DomainError("UNAUTHENTICATED", "Unknown or expired session token");
  return session;
}

/** Throws 403 for restricted or revoked sessions. */
export function assertSessionActive(session: Session): void {
  if (session.status === "RESTRICTED") {
    throw new DomainError("SESSION_RESTRICTED", "Change refused: this session is restricted.");
  }
  if (session.status === "REVOKED") {
    throw new DomainError("SESSION_REVOKED", "Change refused: this session is revoked.");
  }
}

/** True when the session's device is trusted now and the session is ACTIVE. */
export function isTrustedActiveSession(session: Session): boolean {
  return session.status === "ACTIVE" && findDevice(session.deviceId)?.trusted === true;
}

// ---------------------------------------------------------------------------
// Risk facts
// ---------------------------------------------------------------------------

/** Median of all SETTLED payments, optionally ignoring one payment. */
export function typicalAmount(excludePaymentId?: string): number {
  return median(
    getState()
      .payments.filter((p) => p.status === "SETTLED" && p.id !== excludePaymentId)
      .map((p) => p.amount),
  );
}

export function buildRiskFacts(session: Session, payment?: RiskPaymentFacts): RiskFacts {
  const state = getState();
  const device = findDevice(session.deviceId);
  const meta = state.sessionMeta[session.id];
  return {
    sessionId: session.id,
    loginAt: session.createdAt,
    device: {
      label: device?.label ?? session.deviceId,
      platform: device?.platform ?? "unknown",
      trustedAtLogin: meta?.deviceTrustedAtLogin ?? device?.trusted ?? false,
    },
    network: { city: session.network.city, country: session.network.country },
    homeCountry: state.customer.homeCountry,
    sim: { swapConfirmed: state.sim.swapConfirmed, swappedAt: state.sim.swappedAt },
    beneficiariesAddedInSession: state.beneficiaries
      .filter((b) => b.createdBySessionId === session.id)
      .map((b) => ({ name: b.name, createdAt: b.createdAt })),
    typicalAmount: typicalAmount(),
    payment,
  };
}

/** Assesses the session with the Risk Engine, stores the result and audits it. */
export function assessSession(
  session: Session,
  context: string,
  payment?: RiskPaymentFacts,
  paymentId?: string,
): RiskAssessment {
  const state = getState();
  const assessment = assessRisk(buildRiskFacts(session, payment), state.risk[session.id], now());
  state.risk[session.id] = assessment;
  touch();
  audit({
    actor: "risk-engine",
    action: "RISK_ASSESSED",
    sessionId: session.id,
    paymentId,
    detail: `${context}: risk ${assessment.score} (${assessment.level}) -> ${assessment.action}${
      assessment.signals.length ? `. Signals: ${assessment.signals.map((s) => `${s.id} +${s.points}`).join(", ")}` : ""
    }`,
    data: { score: assessment.score, level: assessment.level, action: assessment.action },
  });
  return assessment;
}

// ---------------------------------------------------------------------------
// Login, SIM signal, beneficiaries
// ---------------------------------------------------------------------------

/** Simulates a successful password + OTP login. Unknown devices are recorded as untrusted. */
export function login(input: LoginRequest): LoginResponse {
  const state = getState();
  const at = advanceClock(input.at);

  let device = findDevice(input.deviceId);
  if (!device) {
    if (!input.device) {
      throw new DomainError("INVALID_REQUEST", `Unknown device ${input.deviceId}: provide device label and platform`);
    }
    device = {
      id: input.deviceId,
      label: input.device.label,
      platform: input.device.platform,
      trusted: false,
      firstSeenAt: at,
      lastSeenAt: at,
    };
    state.devices.push(device);
  } else {
    device.lastSeenAt = at;
  }

  const session: Session = {
    id: nextId("sess"),
    token: `tok-${randomUUID()}`,
    deviceId: device.id,
    network: { ...input.network },
    createdAt: at,
    status: "ACTIVE",
  };
  state.sessions.push(session);
  state.sessionMeta[session.id] = { deviceTrustedAtLogin: device.trusted };
  touch();

  audit({
    actor: "customer",
    action: "LOGIN_SUCCEEDED",
    sessionId: session.id,
    detail: `Login accepted (simulated: password and SMS code assumed correct). Device ${device.label} (${device.platform}, ${
      device.trusted ? "trusted" : "not in device history"
    }), network ${session.network.city}, ${session.network.country}`,
    data: { deviceId: device.id, trusted: device.trusted, country: session.network.country },
  });

  const risk = assessSession(session, "Login");
  return { session, risk };
}

/** Records a synthetic telco SIM swap signal and re-assesses every live session. */
export function reportSimSwap(input: SimSwapRequest): { sim: SimStatus } {
  const state = getState();
  const at = advanceClock(input.at);
  const swappedAt = normalizeIso(input.swappedAt);
  state.sim = {
    source: "synthetic-telco-signal",
    swapConfirmed: true,
    swappedAt,
    reportedAt: at,
  };
  touch();
  audit({
    actor: "telco-signal",
    action: "SIM_SWAP_REPORTED",
    detail: `Synthetic telco signal: SIM swapped at ${clockLabel(swappedAt)}, phone number ${state.customer.maskedPhone}`,
    data: { swappedAt },
  });

  for (const session of state.sessions) {
    if (session.status !== "REVOKED") assessSession(session, "SIM swap signal");
  }
  return { sim: state.sim };
}

export function addBeneficiary(
  token: string | null,
  input: AddBeneficiaryRequest,
): { beneficiary: Beneficiary; risk: RiskAssessment } {
  const session = authenticate(token);
  assertSessionActive(session);
  const state = getState();
  const at = advanceClock(input.at);

  const beneficiary: Beneficiary = {
    id: nextId("ben"),
    name: input.name,
    iban: input.iban,
    createdAt: at,
    createdBySessionId: session.id,
    settledPaymentCount: 0,
  };
  state.beneficiaries.push(beneficiary);
  touch();
  audit({
    actor: "customer",
    action: "BENEFICIARY_ADDED",
    sessionId: session.id,
    detail: `Beneficiary "${beneficiary.name}" added`,
    data: { beneficiaryId: beneficiary.id },
  });

  const risk = assessSession(session, "Beneficiary added");
  return { beneficiary, risk };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export function assertFunds(amount: number): void {
  const { customer } = getState();
  if (amount > customer.balance) {
    throw new DomainError(
      "INSUFFICIENT_FUNDS",
      `Insufficient funds: balance ${formatAed(customer.balance)}, requested ${formatAed(amount)}`,
    );
  }
}

/** Debits the account and marks the payment SETTLED. The only place where money leaves. */
export function debitAndSettle(payment: Payment, actor: Actor, reason: string): Payment {
  const state = getState();
  const fils = Math.round(payment.amount * 100);
  if (!Number.isFinite(payment.amount) || fils < 1 || Math.abs(payment.amount * 100 - fils) > 1e-6) {
    throw new DomainError("INVALID_REQUEST", `Amount ${payment.amount} is not a positive whole number of fils`);
  }
  assertFunds(payment.amount);
  const at = now();
  state.customer.balance = Math.round((state.customer.balance - payment.amount) * 100) / 100;
  payment.status = "SETTLED";
  payment.settledAt = at;
  const beneficiary = findBeneficiary(payment.beneficiaryId);
  if (beneficiary) beneficiary.settledPaymentCount += 1;
  touch();
  audit({
    actor,
    action: "PAYMENT_SETTLED",
    sessionId: payment.sessionId,
    paymentId: payment.id,
    detail: `${formatAed(payment.amount)} to ${beneficiary?.name ?? payment.beneficiaryId} settled. ${reason}. Balance ${formatAed(
      state.customer.balance,
    )}`,
    data: { amount: payment.amount, balance: state.customer.balance },
  });
  return payment;
}
