/**
 * AI Investigation Agent - entry point and engine wiring.
 *
 * To connect an LLM engine, build an `LlmEngine` (see ./engine.ts) and pass it
 * as `engine` below, then make `getLlmStatus()` report it. Everything else
 * (timeline reporting, time cap, verdict validation, fallback) is handled by
 * the orchestrator.
 */
import type { RunInvestigation } from "@/lib/types";
import { createInvestigator } from "./orchestrator";

export { createInvestigator } from "./orchestrator";
export type { CreateInvestigatorOptions } from "./orchestrator";
export type { EngineRunInput, LlmEngine } from "./engine";

export const ENGINE_NOT_CONNECTED_REASON = "Devin engine not connected yet";

/** LLM availability, shown in the dashboard. */
export function getLlmStatus(): { configured: boolean; model: string | null } {
  return { configured: false, model: null };
}

export const runInvestigation: RunInvestigation = createInvestigator({
  engine: null,
  noEngineReason: ENGINE_NOT_CONNECTED_REASON,
});
