/**
 * Risk Engine: a deterministic, transparent point model.
 *
 * Pure functions only. No store access, no LLM. The caller collects the facts
 * and passes the previous assessment, so signals stay sticky per session.
 */
import {
  RAPID_SEQUENCE_WINDOW_MINUTES,
  RISK_SIGNAL_LABELS,
  RISK_THRESHOLDS,
  RISK_WEIGHTS,
  SIM_SWAP_WINDOW_MINUTES,
  UNUSUAL_AMOUNT_MULTIPLIER,
} from "@/lib/config";
import { formatAed } from "@/lib/format";
import { clockLabel, minutesBetween, parseIso } from "@/lib/time";
import {
  RISK_SIGNAL_ORDER,
  type ISODateTime,
  type RiskAction,
  type RiskAssessment,
  type RiskLevel,
  type RiskSignal,
  type RiskSignalId,
} from "@/lib/types";

const MINUTE_MS = 60_000;

export interface RiskPaymentFacts {
  amount: number;
  beneficiaryName: string;
  /** SETTLED payments to this beneficiary before this one. */
  beneficiarySettledCount: number;
  beneficiaryCreatedInSession: boolean;
  requestedAt: ISODateTime;
}

export interface RiskFacts {
  sessionId: string;
  loginAt: ISODateTime;
  device: { label: string; platform: string; trustedAtLogin: boolean };
  network: { city: string; country: string };
  homeCountry: string;
  sim: { swapConfirmed: boolean; swappedAt: ISODateTime | null };
  /** Beneficiaries created by this session, oldest first. */
  beneficiariesAddedInSession: Array<{ name: string; createdAt: ISODateTime }>;
  /** Median of settled payment history. */
  typicalAmount: number;
  /** Present when a payment is being assessed. */
  payment?: RiskPaymentFacts;
}

export function levelForScore(score: number): RiskLevel {
  if (score >= RISK_THRESHOLDS.critical) return "CRITICAL";
  if (score >= RISK_THRESHOLDS.high) return "HIGH";
  if (score >= RISK_THRESHOLDS.elevated) return "ELEVATED";
  return "LOW";
}

export function actionForLevel(level: RiskLevel): RiskAction {
  switch (level) {
    case "LOW":
      return "ALLOW";
    case "ELEVATED":
      return "STEP_UP";
    case "HIGH":
      return "HOLD";
    case "CRITICAL":
      return "HOLD_AND_RESTRICT";
  }
}

const ACTION_RANK: Record<RiskAction, number> = { ALLOW: 0, STEP_UP: 1, HOLD: 2, HOLD_AND_RESTRICT: 3 };

/** Positive when `a` is stricter than `b`. */
export function compareActions(a: RiskAction, b: RiskAction): number {
  return ACTION_RANK[a] - ACTION_RANK[b];
}

/** Median of the values, 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** True when the amount is at least UNUSUAL_AMOUNT_MULTIPLIER x the typical amount. */
export function isUnusualAmount(amount: number, typicalAmount: number): boolean {
  if (typicalAmount <= 0) return false;
  return amount >= UNUSUAL_AMOUNT_MULTIPLIER * typicalAmount;
}

/** Evidence for every signal that fires on the current facts. */
export function evaluateSignals(facts: RiskFacts): Partial<Record<RiskSignalId, string>> {
  const fired: Partial<Record<RiskSignalId, string>> = {};

  if (!facts.device.trustedAtLogin) {
    fired.UNKNOWN_DEVICE = `Login from ${facts.device.label} (${facts.device.platform}), not in the customer's device history`;
  }

  // Windows compare exact milliseconds; rounded minutes are for the evidence text only.
  if (facts.sim.swapConfirmed && facts.sim.swappedAt) {
    const sinceSwapMs = parseIso(facts.loginAt) - parseIso(facts.sim.swappedAt);
    const minutes = minutesBetween(facts.sim.swappedAt, facts.loginAt);
    if (sinceSwapMs >= 0 && sinceSwapMs <= SIM_SWAP_WINDOW_MINUTES * MINUTE_MS) {
      fired.RECENT_SIM_SWAP = `SIM swapped at ${clockLabel(facts.sim.swappedAt)}, ${minutes} min before login at ${clockLabel(facts.loginAt)}`;
    }
  }

  if (facts.network.country !== facts.homeCountry) {
    fired.UNUSUAL_NETWORK = `Network in ${facts.network.city}, ${facts.network.country}; home country is ${facts.homeCountry}`;
  }

  const added = facts.beneficiariesAddedInSession[0];
  if (added) {
    fired.NEW_BENEFICIARY = `Beneficiary "${added.name}" added in this session at ${clockLabel(added.createdAt)}`;
  } else if (facts.payment && facts.payment.beneficiarySettledCount === 0) {
    fired.NEW_BENEFICIARY = `Transfer to "${facts.payment.beneficiaryName}", which has no settled payments`;
  }

  const payment = facts.payment;
  if (payment && isUnusualAmount(payment.amount, facts.typicalAmount)) {
    const ratio = Math.round((payment.amount / facts.typicalAmount) * 10) / 10;
    fired.UNUSUAL_AMOUNT = `Transfer of ${formatAed(payment.amount)} is ${ratio}x the typical ${formatAed(facts.typicalAmount)}`;
  }

  if (payment && payment.beneficiaryCreatedInSession) {
    const sinceLoginMs = parseIso(payment.requestedAt) - parseIso(facts.loginAt);
    const minutes = minutesBetween(facts.loginAt, payment.requestedAt);
    if (sinceLoginMs >= 0 && sinceLoginMs <= RAPID_SEQUENCE_WINDOW_MINUTES * MINUTE_MS) {
      fired.RAPID_SEQUENCE = `Transfer ${minutes} min after login, to a beneficiary added in this same session`;
    }
  }

  return fired;
}

/** Score, level and action from a set of signals. */
export function scoreSignals(ids: RiskSignalId[]): { score: number; level: RiskLevel; action: RiskAction } {
  const score = Math.min(
    100,
    ids.reduce((sum, id) => sum + RISK_WEIGHTS[id], 0),
  );
  const level = levelForScore(score);
  return { score, level, action: actionForLevel(level) };
}

/**
 * Assesses a session. Signals from `previous` stay fired (sticky), keep their
 * evidence and their first detection time. New signals get `assessedAt`.
 */
export function assessRisk(
  facts: RiskFacts,
  previous: RiskAssessment | undefined,
  assessedAt: ISODateTime,
): RiskAssessment {
  const fresh = evaluateSignals(facts);
  const prior = new Map<RiskSignalId, RiskSignal>();
  if (previous && previous.sessionId === facts.sessionId) {
    for (const s of previous.signals) prior.set(s.id, s);
  }

  const signals: RiskSignal[] = [];
  let cumulative = 0;
  for (const id of RISK_SIGNAL_ORDER) {
    const old = prior.get(id);
    const evidence = old?.evidence ?? fresh[id];
    if (evidence === undefined) continue;
    const points = RISK_WEIGHTS[id];
    cumulative = Math.min(100, cumulative + points);
    signals.push({
      id,
      label: RISK_SIGNAL_LABELS[id],
      points,
      evidence,
      cumulative,
      detectedAt: old?.detectedAt ?? assessedAt,
    });
  }

  const { score, level, action } = scoreSignals(signals.map((s) => s.id));
  return { sessionId: facts.sessionId, score, level, action, signals, assessedAt };
}
