/**
 * AI Investigation Agent - entry point.
 *
 * PLACEHOLDER: a minimal deterministic investigator that satisfies the
 * RunInvestigation contract, so the bank core can be built and tested before
 * the real Claude-backed investigator lands in this directory.
 */
import type {
  InvestigationStep,
  InvestigationVerdict,
  RunInvestigation,
  ToolName,
} from "@/lib/types";

/** LLM availability, shown in the dashboard. */
export function getLlmStatus(): { configured: boolean; model: string | null } {
  const forced = process.env.GLD_FORCE_FALLBACK === "1";
  const configured = !forced && Boolean(process.env.ANTHROPIC_API_KEY);
  return { configured, model: configured ? (process.env.GLD_MODEL ?? "claude-sonnet-5-5") : null };
}

export const runInvestigation: RunInvestigation = async (ctx, tools, sink, options) => {
  const stepDelayMs = options?.stepDelayMs ?? Number(process.env.GLD_STEP_DELAY_MS ?? 600);
  sink.engineSelected({
    engine: "deterministic-fallback",
    fallbackReason: "Placeholder investigator (no LLM wired yet)",
  });

  let n = 0;
  async function call<T>(tool: ToolName, input: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    const started: InvestigationStep = {
      kind: "tool_call",
      id: `${ctx.investigationId}-step-${++n}`,
      tool,
      input,
      status: "running",
      startedAt: sink.now(),
    };
    sink.stepStarted(started);
    if (stepDelayMs > 0) await new Promise((r) => setTimeout(r, stepDelayMs));
    const output = await run();
    sink.stepFinished({ ...started, status: "ok", output, finishedAt: sink.now() });
    return output;
  }

  await call("get_device_history", {}, () => tools.get_device_history());
  await call("get_sim_status", {}, () => tools.get_sim_status());
  await call("get_session_activity", {}, () => tools.get_session_activity());
  await call("get_payment_history", {}, () => tools.get_payment_history());
  await call("check_beneficiary", {}, () => tools.check_beneficiary());

  const evidence = ctx.risk.signals.map((s) => `${s.label}: ${s.evidence} (+${s.points})`);
  const holds = ctx.risk.action === "HOLD" || ctx.risk.action === "HOLD_AND_RESTRICT";

  let incidentId: string | undefined;
  if (holds) {
    const input = {
      title: "Suspected account takeover",
      severity: ctx.risk.level,
      reasons: evidence,
    };
    const incident = await call("create_incident", input, () => tools.create_incident(input));
    incidentId = incident.id;
  }

  const verdict: InvestigationVerdict = {
    assessment: holds ? "LIKELY_ACCOUNT_TAKEOVER" : "SUSPICIOUS",
    summary: `Risk score ${ctx.risk.score} (${ctx.risk.level}).`,
    evidence,
    recommendedAction: ctx.risk.action,
    incidentId,
  };
  return {
    engine: "deterministic-fallback",
    fallbackReason: "Placeholder investigator (no LLM wired yet)",
    verdict,
  };
};
