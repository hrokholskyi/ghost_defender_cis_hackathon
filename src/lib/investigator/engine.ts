/**
 * The seam an LLM engine (for example Devin) plugs into.
 *
 * An engine gets a tools object that already reports every call to the
 * dashboard timeline, a `note` callback for short narration, and an abort
 * signal. It returns a raw verdict object. The orchestrator validates that
 * object, fills in the incident id itself, and switches to the deterministic
 * fallback on any problem. An engine never sees the sink and cannot hold,
 * release or execute anything.
 */
import type { InvestigationContext, InvestigationEngine, InvestigationTools } from "@/lib/types";

export interface EngineRunInput {
  ctx: InvestigationContext;
  /** Bound to one session and one payment. Every call shows up in the timeline. */
  tools: InvestigationTools;
  /** Short narration between tool calls. Trimmed to about 280 characters; empty text is skipped. */
  note(text: string): void;
  /** Aborted when the time cap fires. Tool calls after that are refused. */
  signal: AbortSignal;
}

export interface LlmEngine {
  id: Exclude<InvestigationEngine, "deterministic-fallback">;
  model?: string;
  /**
   * Resolves with a raw verdict: `{ assessment, summary, evidence, recommendedAction }`.
   * It is validated against `InvestigationVerdict`; any `incidentId` it carries is ignored.
   */
  run(input: EngineRunInput): Promise<unknown>;
}
