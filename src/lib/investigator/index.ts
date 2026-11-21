/**
 * AI Investigation Agent - entry point and engine wiring.
 *
 * The LLM engine is Devin (see ./devin). It is used only when DEVIN_API_KEY,
 * DEVIN_ORG_ID and GLD_PUBLIC_URL are set and GLD_FORCE_FALLBACK is not 1.
 * Env is read on every call, not at module load. Everything else (timeline
 * reporting, time cap, verdict validation, fallback) is handled by the
 * orchestrator.
 */
import type { RunInvestigation } from "@/lib/types";
import { isFallbackForced, resolveDevinConfig, type InvestigatorEnv } from "./config";
import { createDevinClient, type DevinClient, type DevinClientOptions } from "./devin/client";
import { createDevinEngine, devinModelLabel, type Sleep } from "./devin/engine";
import { createInvestigator } from "./orchestrator";

export { createInvestigator } from "./orchestrator";
export type { CreateInvestigatorOptions } from "./orchestrator";
export type { EngineRunInput, LlmEngine } from "./engine";

/** LLM availability, shown in the dashboard. */
export function getLlmStatus(env: InvestigatorEnv = process.env): { configured: boolean; model: string | null } {
  if (isFallbackForced(env)) return { configured: false, model: null };
  const devin = resolveDevinConfig(env);
  return devin.ok ? { configured: true, model: devinModelLabel(devin.config.mode) } : { configured: false, model: null };
}

export interface InvestigatorFromEnvDeps {
  /** Replaces the real Devin REST client, for tests. */
  createClient?: (options: DevinClientOptions) => DevinClient;
  sleep?: Sleep;
}

/** Builds an investigator for the given env: the Devin engine when configured, the fallback otherwise. */
export function investigatorFromEnv(env: InvestigatorEnv, deps: InvestigatorFromEnvDeps = {}): RunInvestigation {
  if (isFallbackForced(env)) return createInvestigator({ env, engine: null });
  const devin = resolveDevinConfig(env);
  if (!devin.ok) return createInvestigator({ env, engine: null, noEngineReason: devin.reason });

  const { config } = devin;
  const client = (deps.createClient ?? createDevinClient)({
    apiKey: config.apiKey,
    orgId: config.orgId,
    baseUrl: config.apiBaseUrl,
  });
  const engine = createDevinEngine({
    client,
    publicUrl: config.publicUrl,
    mode: config.mode,
    maxAcu: config.maxAcu,
    pollIntervalMs: config.pollIntervalMs,
    sleep: deps.sleep,
  });
  return createInvestigator({ env, engine, engineTimeoutMs: config.timeoutMs });
}

export const runInvestigation: RunInvestigation = (ctx, tools, sink, options) =>
  investigatorFromEnv(process.env)(ctx, tools, sink, options);
