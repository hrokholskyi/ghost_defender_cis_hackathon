/**
 * Picks the records of the active scenario run out of a snapshot: the actor
 * session (the one the scenario logged in), its payment, investigation,
 * verification and incident. Pure, no DOM.
 */
import type {
  Beneficiary,
  Device,
  Incident,
  Investigation,
  Payment,
  RiskAssessment,
  RiskSignal,
  ScenarioInfo,
  Session,
  StateSnapshot,
  VerificationRequest,
} from "@/lib/types";
import { hm } from "./format";

export interface RunContext {
  info: ScenarioInfo | undefined;
  /** Steps that already ran in the backend. */
  arrived: number;
  total: number;
  actorSession: Session | undefined;
  actorDevice: Device | undefined;
  assessment: RiskAssessment | undefined;
  payment: Payment | undefined;
  beneficiary: Beneficiary | undefined;
  investigation: Investigation | undefined;
  verification: VerificationRequest | undefined;
  incident: Incident | undefined;
  /** The customer's trusted device. */
  trustedDevice: Device | undefined;
  /** Session that receives the verification push. */
  trustedSession: Session | undefined;
}

/** Identifies one scenario run. Changes on every scenario start or reset. */
export function runKey(s: StateSnapshot): string {
  return `${s.scenario?.id ?? "none"}:${s.audit[0]?.seq ?? 0}`;
}

export function runContext(s: StateSnapshot): RunContext {
  const progress = s.scenario;
  const info = progress ? s.scenarios.find((x) => x.id === progress.id) : undefined;
  const actorSession = progress?.actorSessionId ? s.sessions.find((x) => x.id === progress.actorSessionId) : undefined;
  const actorDevice = actorSession ? s.devices.find((d) => d.id === actorSession.deviceId) : undefined;
  const assessment = actorSession ? s.risk[actorSession.id] : undefined;

  const own = actorSession ? s.payments.filter((p) => !p.historical && p.sessionId === actorSession.id) : [];
  const payment = [...own].reverse().find((p) => p.status !== "REJECTED") ?? own[own.length - 1];

  const beneficiary = payment
    ? s.beneficiaries.find((b) => b.id === payment.beneficiaryId)
    : actorSession
      ? s.beneficiaries.find((b) => b.createdBySessionId === actorSession.id)
      : undefined;

  const investigation = payment ? [...s.investigations].reverse().find((i) => i.paymentId === payment.id) : undefined;
  const verification = payment ? [...s.verifications].reverse().find((v) => v.paymentId === payment.id) : undefined;
  const incident = payment ? s.incidents.find((i) => i.paymentId === payment.id) : undefined;

  const trustedDevice = s.devices.find((d) => d.trusted);
  const trustedSession = verification?.targetSessionId
    ? s.sessions.find((x) => x.id === verification.targetSessionId)
    : s.sessions.find((x) => x.deviceId === trustedDevice?.id && x.id !== actorSession?.id && x.status === "ACTIVE");

  return {
    info,
    arrived: progress?.nextStep ?? 0,
    total: progress?.totalSteps ?? 0,
    actorSession,
    actorDevice,
    assessment,
    payment,
    beneficiary,
    investigation,
    verification,
    incident,
    trustedDevice,
    trustedSession,
  };
}

/**
 * The scenario step (1-based) a signal belongs to: the number of steps whose
 * scripted clock is at or before the signal's detection time. 0 when unknown.
 */
export function stepOfSignal(signal: RiskSignal, info: ScenarioInfo | undefined): number {
  if (!info) return 0;
  const at = hm(signal.detectedAt);
  return info.steps.filter((step) => step.clock <= at).length;
}

/** True when the payment gateway held this payment by code. */
export function heldByGateway(payment: Payment | undefined): boolean {
  return !!payment && (payment.action === "HOLD" || payment.action === "HOLD_AND_RESTRICT");
}
