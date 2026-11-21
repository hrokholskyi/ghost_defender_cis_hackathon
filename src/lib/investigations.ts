/**
 * Investigation orchestration.
 *
 * Runs after the gateway already protected the money. The investigator only
 * recommends; its recommendation goes through the Policy Gateway as
 * `ai-investigator`, which can only tighten. Whatever the model does, a HELD
 * payment always ends with an incident.
 */
import { audit } from "@/lib/audit";
import { findPayment, findSession } from "@/lib/bank";
import { now } from "@/lib/clock";
import { findIncidentForPayment, openIncident } from "@/lib/incidents";
import { getLlmStatus, runInvestigation } from "@/lib/investigator";
import { holdPayment, restrictSession } from "@/lib/policy-gateway";
import { compareActions } from "@/lib/risk-engine";
import { epochSignal, getState, nextId, touch } from "@/lib/store";
import { buildInvestigationTools } from "@/lib/tools";
import type {
  Investigation,
  InvestigationContext,
  InvestigationResult,
  InvestigationSink,
  Payment,
  RiskAction,
  RiskAssessment,
} from "@/lib/types";

const PENDING_KEY = "__ghostLoginDefenderInvestigations";
type GlobalWithPending = typeof globalThis & { [PENDING_KEY]?: Set<Promise<void>> };

function pending(): Set<Promise<void>> {
  const g = globalThis as GlobalWithPending;
  if (!g[PENDING_KEY]) g[PENDING_KEY] = new Set();
  return g[PENDING_KEY];
}

/** Resolves when no investigation is running. */
export async function whenIdle(): Promise<void> {
  const set = pending();
  while (set.size > 0) {
    await Promise.allSettled([...set]);
  }
}

function findInvestigation(id: string): Investigation | undefined {
  return getState().investigations.find((i) => i.id === id);
}

/**
 * Creates the investigation record synchronously and runs the investigator in
 * the background. Never blocks the caller and never throws.
 */
export function startInvestigation(
  payment: Payment,
  risk: RiskAssessment,
  appliedAction: RiskAction,
  beneficiaryName: string,
): Investigation {
  const state = getState();
  const epoch = state.epoch;
  const investigation: Investigation = {
    id: nextId("inv"),
    sessionId: payment.sessionId,
    paymentId: payment.id,
    status: "RUNNING",
    engine: getLlmStatus().configured ? "devin" : "deterministic-fallback",
    steps: [],
    startedAt: now(),
  };
  state.investigations.push(investigation);
  touch();
  audit({
    actor: "ai-investigator",
    action: "INVESTIGATION_STARTED",
    sessionId: payment.sessionId,
    paymentId: payment.id,
    detail: `Investigation ${investigation.id} started after the gateway applied ${appliedAction}`,
    data: { investigationId: investigation.id },
  });

  const ctx: InvestigationContext = {
    investigationId: investigation.id,
    sessionId: payment.sessionId,
    paymentId: payment.id,
    risk: structuredClone(risk),
    appliedAction,
    payment: { amount: payment.amount, currency: payment.currency, beneficiaryName },
  };

  const live = () => getState().epoch === epoch;
  const record = () => (live() ? findInvestigation(investigation.id) : undefined);

  const sink: InvestigationSink = {
    engineSelected(info) {
      const inv = record();
      if (!inv) return;
      inv.engine = info.engine;
      if (info.model !== undefined) inv.model = info.model;
      else delete inv.model;
      if (info.fallbackReason !== undefined) inv.fallbackReason = info.fallbackReason;
      else delete inv.fallbackReason;
      touch();
    },
    stepStarted(step) {
      const inv = record();
      if (!inv) return;
      inv.steps.push(structuredClone(step));
      touch();
    },
    stepFinished(step) {
      const inv = record();
      if (!inv) return;
      const index = inv.steps.findIndex((s) => s.id === step.id);
      if (index >= 0) inv.steps[index] = structuredClone(step);
      else inv.steps.push(structuredClone(step));
      touch();
    },
    now: () => now(),
  };

  const tools = buildInvestigationTools(payment.sessionId, payment.id, epoch);
  // Aborted by the next reset: the engine stops, its grant ends, no fallback runs.
  const signal = epochSignal();

  const run = (async () => {
    // Let the HTTP response go out first.
    await Promise.resolve();
    let result: InvestigationResult | undefined;
    let failure: unknown;
    try {
      result = await runInvestigation(ctx, tools, sink, { signal });
    } catch (error) {
      failure = error;
    }
    if (!live()) return;
    try {
      if (result) completeInvestigation(investigation.id, result);
      else failInvestigation(investigation.id, failure);
    } finally {
      ensureIncidentForHeldPayment(payment.id);
    }
  })()
    .catch((error) => {
      console.error("Investigation orchestration failed", error);
    })
    .finally(() => {
      pending().delete(run);
    });
  pending().add(run);

  return investigation;
}

function completeInvestigation(id: string, result: InvestigationResult): void {
  const inv = findInvestigation(id);
  if (!inv) return;
  inv.engine = result.engine;
  if (result.model !== undefined) inv.model = result.model;
  if (result.fallbackReason !== undefined) inv.fallbackReason = result.fallbackReason;
  inv.verdict = structuredClone(result.verdict);
  const incident = findIncidentForPayment(inv.paymentId);
  if (incident && !inv.verdict.incidentId) inv.verdict.incidentId = incident.id;
  inv.status = "COMPLETED";
  inv.finishedAt = now();
  touch();
  audit({
    actor: "ai-investigator",
    action: "INVESTIGATION_COMPLETED",
    sessionId: inv.sessionId,
    paymentId: inv.paymentId,
    detail: `${inv.id}: ${result.verdict.assessment}, recommends ${result.verdict.recommendedAction} (engine ${result.engine})`,
    data: {
      investigationId: inv.id,
      assessment: result.verdict.assessment,
      recommendedAction: result.verdict.recommendedAction,
      engine: result.engine,
    },
  });
  applyRecommendation(inv, result.verdict.recommendedAction);
}

function failInvestigation(id: string, error: unknown): void {
  const inv = findInvestigation(id);
  if (!inv) return;
  const message = error instanceof Error ? error.message : String(error);
  const at = now();
  inv.steps = inv.steps.map((s) =>
    s.kind === "tool_call" && s.status === "running" ? { ...s, status: "error", error: message, finishedAt: at } : s,
  );
  inv.status = "FAILED";
  inv.finishedAt = at;
  touch();
  audit({
    actor: "ai-investigator",
    action: "INVESTIGATION_FAILED",
    sessionId: inv.sessionId,
    paymentId: inv.paymentId,
    detail: `${inv.id} failed: ${message}. Protective actions stay in place`,
    data: { investigationId: inv.id },
  });
}

/** Applies the investigator's recommendation. It can only tighten protection. */
function applyRecommendation(inv: Investigation, recommended: RiskAction): void {
  const payment = findPayment(inv.paymentId);
  const session = findSession(inv.sessionId);
  if (!payment || !session) return;

  const stillOpen = payment.status === "HELD" || payment.status === "PENDING_VERIFICATION";
  // What protects this payment, not the session: a later payment may have restricted the session
  // while this one still waits for step-up.
  const applied: RiskAction =
    payment.status === "HELD"
      ? compareActions(payment.action, "HOLD") > 0
        ? payment.action
        : "HOLD"
      : payment.action;

  let changed = false;
  if (stillOpen && compareActions(recommended, applied) > 0) {
    const reason = `AI investigation ${inv.id} recommended ${recommended}`;
    if (payment.status === "PENDING_VERIFICATION" && compareActions(recommended, "HOLD") >= 0) {
      changed = holdPayment("ai-investigator", payment.id, reason).changed || changed;
    }
    if (recommended === "HOLD_AND_RESTRICT" && session.status === "ACTIVE") {
      changed = restrictSession("ai-investigator", session.id, reason).changed || changed;
    }
  }

  if (!changed) {
    const why = !stillOpen
      ? `the payment is already ${payment.status}`
      : compareActions(recommended, applied) < 0
        ? `it is weaker than the applied ${applied}; the investigator cannot loosen protection`
        : compareActions(recommended, applied) > 0 && session.status !== "ACTIVE"
          ? `the session is already ${session.status}`
          : `${applied} is already in place`;
    audit({
      actor: "policy-gateway",
      action: "RECOMMENDATION_NOTED",
      sessionId: inv.sessionId,
      paymentId: inv.paymentId,
      detail: `Recommendation ${recommended} from ${inv.id} noted, nothing changed: ${why}`,
      data: { investigationId: inv.id, recommendedAction: recommended, appliedAction: applied },
    });
  }
}

/** Mandatory, independent of the model: a HELD payment always has an incident. */
function ensureIncidentForHeldPayment(paymentId: string): void {
  const payment = findPayment(paymentId);
  if (!payment || payment.status !== "HELD" || findIncidentForPayment(paymentId)) return;
  openIncident("policy-gateway", payment.sessionId, payment.id, {
    title: "Payment held before debit: suspected account takeover",
    severity: payment.riskLevel,
    reasons: [...payment.reasons],
  });
}
