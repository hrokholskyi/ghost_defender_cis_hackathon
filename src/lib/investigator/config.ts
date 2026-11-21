/**
 * Tuning knobs for the investigator, read from env.
 */

export const DEFAULT_STEP_DELAY_MS = 600;
/** Cap on the whole LLM engine phase. */
export const DEFAULT_ENGINE_TIMEOUT_MS = 45_000;
/** Timeout for one injected tool call, in both phases. */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export type InvestigatorEnv = Record<string, string | undefined>;

export function isFallbackForced(env: InvestigatorEnv): boolean {
  return env.GLD_FORCE_FALLBACK?.trim() === "1";
}

/** `options.stepDelayMs` wins over `GLD_STEP_DELAY_MS`, which wins over the default. */
export function resolveStepDelay(env: InvestigatorEnv, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) return override;
  const raw = env.GLD_STEP_DELAY_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_STEP_DELAY_MS;
}
