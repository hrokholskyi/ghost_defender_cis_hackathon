/**
 * Tuning knobs for the investigator, read from env.
 */

export const DEFAULT_STEP_DELAY_MS = 600;
/** Cap on the whole LLM engine phase. */
export const DEFAULT_ENGINE_TIMEOUT_MS = 45_000;
/** Timeout for one injected tool call, in both phases. */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** Cap on the Devin engine phase. A Devin session needs tens of seconds to minutes. */
export const DEFAULT_DEVIN_TIMEOUT_MS = 240_000;
/** Devin docs discourage polling faster than every 10 seconds. */
export const DEFAULT_DEVIN_POLL_MS = 10_000;
export const MIN_DEVIN_POLL_MS = 1_000;
export const DEFAULT_DEVIN_API_BASE_URL = "https://api.devin.ai";

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

export interface DevinConfig {
  apiKey: string;
  orgId: string;
  apiBaseUrl: string;
  /** Public base URL of this app, without a trailing slash. */
  publicUrl: string;
  mode?: string;
  maxAcu?: number;
  timeoutMs: number;
  pollIntervalMs: number;
}

export type DevinConfigResult = { ok: true; config: DevinConfig } | { ok: false; reason: string };

const REQUIRED_DEVIN_VARS = ["DEVIN_API_KEY", "DEVIN_ORG_ID", "GLD_PUBLIC_URL"] as const;

/**
 * Reads the Devin settings. Does not look at GLD_FORCE_FALLBACK; the
 * orchestrator handles that. `reason` names exactly what is missing or wrong.
 */
export function resolveDevinConfig(env: InvestigatorEnv): DevinConfigResult {
  const value = (name: string) => env[name]?.trim() ?? "";
  const missing = REQUIRED_DEVIN_VARS.filter((name) => !value(name));
  if (missing.length > 0) return { ok: false, reason: `Devin not configured: set ${listWords(missing)}` };

  const publicUrl = normalizePublicUrl(value("GLD_PUBLIC_URL"));
  if (!publicUrl) {
    return { ok: false, reason: "Devin not configured: GLD_PUBLIC_URL must be a plain http(s) URL such as https://example.trycloudflare.com" };
  }
  const apiBaseUrl = normalizePublicUrl(value("DEVIN_API_BASE_URL") || DEFAULT_DEVIN_API_BASE_URL);
  if (!apiBaseUrl) return { ok: false, reason: "Devin not configured: DEVIN_API_BASE_URL is not a valid http(s) URL" };

  const mode = value("GLD_DEVIN_MODE") || undefined;
  if (mode !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(mode)) {
    return { ok: false, reason: "Devin not configured: GLD_DEVIN_MODE must be a mode name such as fast or normal" };
  }

  let maxAcu: number | undefined;
  const rawAcu = value("GLD_DEVIN_MAX_ACU");
  if (rawAcu) {
    maxAcu = Number(rawAcu);
    if (!Number.isInteger(maxAcu) || maxAcu < 1) {
      return { ok: false, reason: "Devin not configured: GLD_DEVIN_MAX_ACU must be a positive integer" };
    }
  }

  return {
    ok: true,
    config: {
      apiKey: value("DEVIN_API_KEY"),
      orgId: value("DEVIN_ORG_ID"),
      apiBaseUrl,
      publicUrl,
      mode,
      maxAcu,
      timeoutMs: positiveInt(value("GLD_DEVIN_TIMEOUT_MS"), DEFAULT_DEVIN_TIMEOUT_MS, 1_000),
      pollIntervalMs: positiveInt(value("GLD_DEVIN_POLL_MS"), DEFAULT_DEVIN_POLL_MS, MIN_DEVIN_POLL_MS),
    },
  };
}

/**
 * `https://host[:port][/path]` without a trailing slash, or null. Query,
 * fragment, credentials and shell-unsafe characters are refused, because the
 * URL is pasted into curl commands in the Devin prompt.
 */
export function normalizePublicUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return /^[A-Za-z0-9._~:/%-]+$/.test(normalized) ? normalized : null;
}

function positiveInt(raw: string, fallback: number, min: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

/** ["A"] -> "A", ["A", "B"] -> "A and B", ["A", "B", "C"] -> "A, B and C". */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
