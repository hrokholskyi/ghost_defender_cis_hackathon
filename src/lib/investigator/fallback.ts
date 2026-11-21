/**
 * Deterministic fallback investigator.
 *
 * Calls the five read tools in a fixed order (reusing results an engine
 * already fetched), builds evidence from the actual tool results, and opens an
 * incident only when the risk engine's action holds the payment.
 */
import type {
  InvestigationContext,
  InvestigationTools,
  InvestigationVerdict,
  RiskAction,
} from "@/lib/types";
import { RISK_LEVEL_LABELS } from "@/lib/config";
import { READ_TOOLS, type ReadResults, type StepRecorder } from "./steps";

export async function runFallback(
  ctx: InvestigationContext,
  tools: InvestigationTools,
  recorder: StepRecorder,
  stepDelayMs: number,
  signal?: AbortSignal,
): Promise<InvestigationVerdict> {
  for (const tool of READ_TOOLS) {
    signal?.throwIfAborted();
    if (recorder.reads[tool] === undefined) await recorder.read(tools, tool, stepDelayMs);
  }
  signal?.throwIfAborted();

  const evidence = buildEvidence(ctx, recorder.reads);
  const recommendedAction = ctx.risk.action;
  const assessment = assessmentFor(recommendedAction);

  if (holdsPayment(recommendedAction) && !recorder.incident) {
    await recorder.createIncident(
      tools,
      { title: incidentTitle(assessment), severity: ctx.risk.level, reasons: evidence },
      stepDelayMs,
    );
  }

  return {
    assessment,
    summary: buildSummary(ctx, recorder.reads, assessment, recorder.incident?.id),
    evidence,
    recommendedAction,
    incidentId: recorder.incident?.id,
  };
}

export function holdsPayment(action: RiskAction): boolean {
  return action === "HOLD" || action === "HOLD_AND_RESTRICT";
}

export function assessmentFor(action: RiskAction): InvestigationVerdict["assessment"] {
  if (holdsPayment(action)) return "LIKELY_ACCOUNT_TAKEOVER";
  if (action === "STEP_UP") return "SUSPICIOUS";
  return "LIKELY_LEGITIMATE";
}

export function incidentTitle(assessment: InvestigationVerdict["assessment"]): string {
  return assessment === "LIKELY_ACCOUNT_TAKEOVER" ? "Suspected account takeover" : "Suspicious payment session";
}

export function buildEvidence(ctx: InvestigationContext, r: ReadResults): string[] {
  const evidence: string[] = [];
  const device = r.get_device_history;
  if (!device) {
    evidence.push("Device history check unavailable.");
  } else {
    const d = device.currentDevice;
    const name = `${clean(d.label)} (${d.platform})`;
    evidence.push(
      d.known
        ? `Login came from a known device: ${name}.`
        : `Login came from a device never seen before: ${name}. The customer has ${plural(device.knownDevices.length, "known device")} on file.`,
    );
  }

  const sim = r.get_sim_status;
  if (!sim || !sim.available) {
    evidence.push("SIM status unavailable: no signal source answered, so the SIM state is unknown.");
  } else if (sim.swapConfirmed) {
    evidence.push(
      sim.minutesBeforeLogin !== null
        ? `SIM swap confirmed ${plural(sim.minutesBeforeLogin, "minute")} before login (synthetic telco signal).`
        : `SIM swap confirmed${sim.swappedAt ? ` at ${sim.swappedAt}` : ""} (synthetic telco signal).`,
    );
  } else {
    evidence.push("No SIM swap reported for this number (synthetic telco signal).");
  }

  const session = r.get_session_activity;
  if (!session) {
    evidence.push("Session activity check unavailable.");
  } else {
    const where = `${clean(session.network.city)}, ${clean(session.network.country)}`;
    evidence.push(
      session.minutesFromLoginToTransfer !== null
        ? `Transfer requested ${plural(session.minutesFromLoginToTransfer, "minute")} after login from ${where}.`
        : `Login from ${where}; no transfer time recorded for this session.`,
    );
  }

  const pay = r.get_payment_history;
  if (!pay) {
    evidence.push(`Payment history check unavailable; the transfer is ${money(ctx.payment.currency, ctx.payment.amount)}.`);
  } else if (pay.settledCount === 0 || pay.typicalAmount <= 0) {
    evidence.push(`Transfer of ${money(pay.currency, pay.currentAmount)}; no settled payment history to compare with.`);
  } else {
    evidence.push(
      `Transfer of ${money(pay.currency, pay.currentAmount)} is ${pay.ratioToTypical}x the typical ${money(pay.currency, pay.typicalAmount)} (largest earlier payment ${money(pay.currency, pay.maxAmount)}, ${plural(pay.settledCount, "settled payment")}).`,
    );
  }

  const ben = r.check_beneficiary;
  if (!ben) {
    evidence.push("Beneficiary check unavailable.");
  } else if (ben.knownBefore) {
    evidence.push(`Beneficiary "${clean(ben.name)}" is known, with ${plural(ben.priorSettledPayments, "earlier settled payment")}.`);
  } else {
    evidence.push(
      `Beneficiary "${clean(ben.name)}" is new, with no earlier settled payments${ben.addedInThisSession ? ", and was added in this same session" : ""}.`,
    );
  }
  return evidence;
}

export function buildSummary(
  ctx: InvestigationContext,
  r: ReadResults,
  assessment: InvestigationVerdict["assessment"],
  incidentId: string | undefined,
): string {
  const sentences: string[] = [];
  const score = `risk score ${ctx.risk.score}, ${RISK_LEVEL_LABELS[ctx.risk.level] ?? ctx.risk.level}`;
  sentences.push(
    assessment === "LIKELY_ACCOUNT_TAKEOVER"
      ? `This session matches the demo account takeover pattern (${score}).`
      : assessment === "SUSPICIOUS"
        ? `This session shows warning signs that need extra verification (${score}).`
        : `This session looks consistent with the customer's normal behaviour (${score}).`,
  );

  const facts: string[] = [];
  const device = r.get_device_history?.currentDevice;
  if (device) facts.push(device.known ? `came from a known ${device.platform} device` : `came from a new ${device.platform} device`);
  const sim = r.get_sim_status;
  if (sim?.available && sim.swapConfirmed && sim.minutesBeforeLogin !== null) {
    facts.push(`followed a SIM swap by ${plural(sim.minutesBeforeLogin, "minute")}`);
  } else if (!sim?.available) {
    facts.push("happened while the SIM state is unknown");
  }
  if (facts.length > 0) sentences.push(`The login ${joinAnd(facts)}.`);

  const pay = r.get_payment_history;
  const ben = r.check_beneficiary;
  const session = r.get_session_activity;
  const transfer: string[] = [];
  if (pay && pay.typicalAmount > 0 && pay.settledCount > 0) transfer.push(`is ${pay.ratioToTypical}x the typical amount`);
  if (ben) transfer.push(ben.knownBefore ? "goes to a known beneficiary" : ben.addedInThisSession ? "goes to a beneficiary added in this session" : "goes to a new beneficiary");
  if (session?.minutesFromLoginToTransfer != null) transfer.push(`was requested ${plural(session.minutesFromLoginToTransfer, "minute")} after login`);
  if (transfer.length > 0) sentences.push(`The ${money(ctx.payment.currency, ctx.payment.amount)} transfer ${joinAnd(transfer)}.`);

  sentences.push(actionSentence(ctx.risk.action, incidentId));
  return sentences.join(" ");
}

function actionSentence(action: RiskAction, incidentId: string | undefined): string {
  const incident = incidentId ? `, and incident ${incidentId} is open for review` : "";
  switch (action) {
    case "HOLD_AND_RESTRICT":
      return `Recommendation: keep the payment held and the session restricted until the customer confirms on a trusted channel${incident}.`;
    case "HOLD":
      return `Recommendation: keep the payment held until the customer confirms on a trusted channel${incident}.`;
    case "STEP_UP":
      return "Recommendation: ask for extra verification on a trusted channel before the payment continues.";
    default:
      return "Recommendation: allow the payment and keep monitoring the session.";
  }
}

function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Tool text (for example an attacker-chosen beneficiary name) is data: strip control chars and cap length. */
function clean(text: string): string {
  const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}
