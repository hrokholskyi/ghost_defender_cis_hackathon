/**
 * Presentation pacing.
 *
 * The backend applies a whole scenario event at once: the TRANSFER of
 * scenario B moves the score from 55 to 90 in one snapshot. The dashboard
 * still plays it as a sequence for the jury: each new signal one at a time,
 * the HOLD stamp when the shown score crosses the high threshold, the
 * SESSION RESTRICTED stamp at the critical threshold, and only then the
 * investigation.
 *
 * `Reveal` records how far the presentation has got. `planReveal` is pure:
 * it returns the next reveal state and how long to wait before showing it,
 * or null when the screen has caught up with the snapshot.
 */
import type { RiskSignalId, StateSnapshot } from "@/lib/types";
import { heldByGateway, runContext, runKey, stepOfSignal } from "./run-context";

export type MomentPhase = "pending" | "showing" | "done";

export interface Reveal {
  runKey: string;
  /** Scenario steps whose arrival beat has passed. */
  steps: number;
  /** Revealed signal ids of the actor session, in reveal order. */
  signals: RiskSignalId[];
  hold: MomentPhase;
  restrict: MomentPhase;
  /** Investigation, incident and verification push become visible. */
  gate: boolean;
  /** Investigation steps shown so far. */
  toolSteps: number;
}

/** Milliseconds. Tuned for a projector pitch. */
export const TIMING = {
  /** Event arrived on screen -> its first consequence (result line, first signal). */
  stepBeat: 1100,
  /** Between two signals of the same event. */
  signalGap: 1200,
  /** Threshold crossed -> stamp appears. */
  momentDelay: 500,
  /** How long a stamp stays. */
  momentHold: 2200,
  /** Last stamp gone -> investigation visible. */
  gateDelay: 700,
  /** Between investigation steps that are already in the snapshot. */
  toolGap: 450,
} as const;

export interface RevealPlan {
  delayMs: number;
  next: Reveal;
}

export function emptyReveal(key: string): Reveal {
  return { runKey: key, steps: 0, signals: [], hold: "pending", restrict: "pending", gate: false, toolSteps: 0 };
}

/** Everything in the snapshot is already shown. Used on page load, so a reload never replays the show. */
export function fullReveal(s: StateSnapshot): Reveal {
  const ctx = runContext(s);
  const signals = ctx.assessment?.signals.map((x) => x.id) ?? [];
  const held = heldByGateway(ctx.payment);
  return {
    runKey: runKey(s),
    steps: ctx.arrived,
    signals,
    hold: held ? "done" : "pending",
    restrict: ctx.payment?.action === "HOLD_AND_RESTRICT" ? "done" : "pending",
    gate: !!ctx.payment,
    toolSteps: ctx.investigation?.steps.length ?? 0,
  };
}

/**
 * Reveal state for a new snapshot. Keeps `prev` within the same run; starts
 * empty for a fresh run; catches up instantly on first load or when the run
 * changed under us with steps already done.
 */
export function syncReveal(prev: Reveal | null, s: StateSnapshot): Reveal {
  const key = runKey(s);
  if (prev && prev.runKey === key) return prev;
  if (prev && (s.scenario?.nextStep ?? 0) === 0) return emptyReveal(key);
  return fullReveal(s);
}

/** Score shown for the revealed signals. Equals the backend score once all are revealed. */
export function revealedScore(s: StateSnapshot, reveal: Reveal): number {
  const assessment = runContext(s).assessment;
  if (!assessment) return 0;
  const shown = assessment.signals.filter((x) => reveal.signals.includes(x.id));
  if (shown.length === assessment.signals.length) return assessment.score;
  // Signals arrive in RISK_SIGNAL_ORDER, so the shown ones are a prefix and `cumulative` is exact.
  const last = shown[shown.length - 1];
  const isPrefix = shown.every((x, i) => assessment.signals[i]?.id === x.id);
  if (last && isPrefix) return last.cumulative;
  return Math.min(100, shown.reduce((sum, x) => sum + x.points, 0));
}

export function planReveal(s: StateSnapshot, r: Reveal): RevealPlan | null {
  if (r.runKey !== runKey(s)) return null;
  const ctx = runContext(s);
  const all = ctx.assessment?.signals ?? [];
  const pending = all.filter((x) => !r.signals.includes(x.id));
  const { high, critical } = s.riskConfig.thresholds;

  if (r.steps < ctx.arrived) {
    const steps = r.steps + 1;
    const first = pending.find((x) => stepOfSignal(x, ctx.info) <= steps);
    return {
      delayMs: TIMING.stepBeat,
      next: { ...r, steps, signals: first ? [...r.signals, first.id] : r.signals },
    };
  }

  if (r.hold === "showing") return { delayMs: TIMING.momentHold, next: { ...r, hold: "done" } };
  if (r.restrict === "showing") return { delayMs: TIMING.momentHold, next: { ...r, restrict: "done" } };

  const score = revealedScore(s, r);
  const payment = ctx.payment;
  if (r.hold === "pending" && heldByGateway(payment) && score >= high) {
    return { delayMs: TIMING.momentDelay, next: { ...r, hold: "showing" } };
  }
  if (r.restrict === "pending" && r.hold === "done" && payment?.action === "HOLD_AND_RESTRICT" && score >= critical) {
    return { delayMs: TIMING.momentDelay, next: { ...r, restrict: "showing" } };
  }

  if (pending.length > 0) {
    return { delayMs: TIMING.signalGap, next: { ...r, signals: [...r.signals, pending[0].id] } };
  }

  if (payment && !r.gate) return { delayMs: TIMING.gateDelay, next: { ...r, gate: true } };

  const steps = ctx.investigation?.steps.length ?? 0;
  if (r.gate && r.toolSteps < steps) {
    return { delayMs: TIMING.toolGap, next: { ...r, toolSteps: r.toolSteps + 1 } };
  }
  return null;
}
