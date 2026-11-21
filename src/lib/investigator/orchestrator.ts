/**
 * Orchestrator: runs the LLM engine (when there is one) under a time cap,
 * validates its verdict, and falls back to the deterministic investigator on
 * any problem. Never throws, never hangs.
 */
import type {
  InvestigationContext,
  InvestigationResult,
  InvestigationSink,
  InvestigationTools,
  InvestigationVerdict,
  RunInvestigation,
} from "@/lib/types";
import {
  DEFAULT_ENGINE_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  isFallbackForced,
  resolveStepDelay,
  type InvestigatorEnv,
} from "./config";
import type { LlmEngine } from "./engine";
import { assessmentFor, holdsPayment, incidentTitle, runFallback } from "./fallback";
import { errorMessage, StepRecorder, trackedTools } from "./steps";
import { describeZodError, plainDashes, submittedVerdictSchema } from "./verdict";

export const FORCED_FALLBACK_REASON = "Deterministic fallback forced by GLD_FORCE_FALLBACK=1";
export const NO_ENGINE_REASON = "No LLM engine configured";

export interface CreateInvestigatorOptions {
  /** LLM engine to try first. Null or undefined means the deterministic fallback only. */
  engine?: LlmEngine | null;
  /** Env to read. Defaults to `process.env`, read on every run. */
  env?: InvestigatorEnv;
  /** `fallbackReason` shown when there is no engine. */
  noEngineReason?: string;
  /** Cap on the whole engine phase. Default 45 s. */
  engineTimeoutMs?: number;
  /** Cap on a single tool call. Default 10 s. */
  toolTimeoutMs?: number;
}

type EngineOutcome = { ok: true; verdict: InvestigationVerdict } | { ok: false; reason: string };

export function createInvestigator(options: CreateInvestigatorOptions = {}): RunInvestigation {
  const engine = options.engine ?? null;
  const engineTimeoutMs = options.engineTimeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  return async (ctx, tools, sink, runOptions) => {
    const env = options.env ?? process.env;
    try {
      const stepDelayMs = resolveStepDelay(env, runOptions?.stepDelayMs);
      const recorder = new StepRecorder(ctx, sink, toolTimeoutMs);

      let fallbackReason: string;
      if (isFallbackForced(env)) {
        fallbackReason = FORCED_FALLBACK_REASON;
      } else if (!engine) {
        fallbackReason = options.noEngineReason ?? NO_ENGINE_REASON;
      } else {
        sink.engineSelected({ engine: engine.id, model: engine.model });
        const outcome = await runEngine(engine, ctx, tools, recorder, engineTimeoutMs);
        if (outcome.ok) return { engine: engine.id, model: engine.model, verdict: outcome.verdict };
        fallbackReason = outcome.reason;
      }

      sink.engineSelected({ engine: "deterministic-fallback", fallbackReason });
      const verdict = await runFallback(ctx, tools, recorder, stepDelayMs);
      return { engine: "deterministic-fallback", fallbackReason, verdict };
    } catch (err) {
      return lastResort(ctx, sink, err);
    }
  };
}

async function runEngine(
  engine: LlmEngine,
  ctx: InvestigationContext,
  tools: InvestigationTools,
  recorder: StepRecorder,
  timeoutMs: number,
): Promise<EngineOutcome> {
  const label = engineLabel(engine);
  const controller = new AbortController();
  let open = true;
  const isOpen = () => open && !controller.signal.aborted;

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`${label} time limit reached`));
      reject(new Error("time limit"));
    }, timeoutMs);
  });

  let raw: unknown;
  try {
    const run = Promise.resolve().then(() =>
      engine.run({
        ctx,
        tools: trackedTools(tools, recorder, isOpen),
        note: (text) => {
          if (isOpen()) recorder.note(text);
        },
        signal: controller.signal,
      }),
    );
    raw = await Promise.race([run, cap]);
  } catch (err) {
    return {
      ok: false,
      reason: timedOut
        ? `${label} did not finish within ${formatSeconds(timeoutMs)}`
        : `${label} failed: ${errorMessage(err)}`,
    };
  } finally {
    open = false;
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new Error(`${label} phase ended`));
  }

  const parsed = submittedVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `${label} returned an invalid verdict (${describeZodError(parsed.error)})` };
  }
  const submitted = parsed.data;

  // The incident id always comes from a real create_incident result, never from the engine.
  if (holdsPayment(submitted.recommendedAction) && !recorder.incident) {
    await recorder.createIncident(tools, {
      title: incidentTitle(submitted.assessment),
      severity: ctx.risk.level,
      reasons: submitted.evidence,
    });
  }

  return {
    ok: true,
    verdict: {
      assessment: submitted.assessment,
      summary: plainDashes(submitted.summary),
      evidence: submitted.evidence.map(plainDashes),
      recommendedAction: submitted.recommendedAction,
      incidentId: recorder.incident?.id,
    },
  };
}

/** Only reached if the sink or something equally unexpected throws. Uses no tools. */
function lastResort(ctx: InvestigationContext, sink: InvestigationSink, err: unknown): InvestigationResult {
  const fallbackReason = `Investigator error: ${errorMessage(err)}`;
  try {
    sink.engineSelected({ engine: "deterministic-fallback", fallbackReason });
  } catch {
    // the sink is what failed; nothing more to report
  }
  const signals = ctx.risk?.signals ?? [];
  return {
    engine: "deterministic-fallback",
    fallbackReason,
    verdict: {
      assessment: assessmentFor(ctx.risk.action),
      summary: `The investigation could not complete, so this verdict repeats the risk engine result (score ${ctx.risk.score}, ${ctx.risk.level}). Recommended action: ${ctx.risk.action}.`,
      evidence: signals.length > 0 ? signals.map((s) => `${s.label}: ${s.evidence}`) : ["No risk signals recorded."],
      recommendedAction: ctx.risk.action,
    },
  };
}

function engineLabel(engine: LlmEngine): string {
  return `${engine.id.charAt(0).toUpperCase()}${engine.id.slice(1)} engine`;
}

function formatSeconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
}
