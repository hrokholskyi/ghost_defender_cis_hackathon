/**
 * Tool grants: one investigation's access to its tools over HTTP.
 *
 * The Devin session gets a random bearer token. Only its SHA-256 hash is kept,
 * and lookups go by hash. A grant ends when the verdict is submitted, when the
 * engine run is aborted or settles, or when it expires. Ended grants are
 * deleted, so every later call gets the same generic 401.
 *
 * The registry lives on `globalThis`: in `next dev`, the route handler and the
 * engine can be loaded as different module instances in the same process.
 */
import { createHash, randomBytes } from "node:crypto";
import type { InvestigationTools } from "@/lib/types";

export const DEFAULT_GRANT_TTL_MS = 10 * 60_000;
export const DEFAULT_GRANT_MAX_CALLS = 40;

export interface ToolGrant {
  readonly tokenHash: string;
  readonly investigationId: string;
  /** Tracked tools from EngineRunInput: every call lands on the timeline. */
  readonly tools: InvestigationTools;
  /** Epoch milliseconds (wall clock, not the simulated clock). */
  readonly expiresAt: number;
  readonly maxCalls: number;
  callCount: number;
  /** The grant is dead once this is aborted. */
  readonly signal: AbortSignal;
  /** Hands the raw submitted verdict to the engine. */
  resolveVerdict(raw: unknown): void;
}

export interface CreateGrantInput {
  investigationId: string;
  tools: InvestigationTools;
  signal: AbortSignal;
  resolveVerdict(raw: unknown): void;
  ttlMs?: number;
  maxCalls?: number;
  now?: () => number;
}

export interface IssuedGrant {
  /** Plain token for the prompt. Never stored. */
  token: string;
  grant: ToolGrant;
  end(): void;
}

const REGISTRY_KEY = "__ghostLoginDefenderToolGrants";
type GlobalWithGrants = typeof globalThis & { [REGISTRY_KEY]?: Map<string, ToolGrant> };

function registry(): Map<string, ToolGrant> {
  const g = globalThis as GlobalWithGrants;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY];
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createGrant(input: CreateGrantInput): IssuedGrant {
  const now = input.now ?? Date.now;
  sweep(now());
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const grant: ToolGrant = {
    tokenHash,
    investigationId: input.investigationId,
    tools: input.tools,
    expiresAt: now() + (input.ttlMs ?? DEFAULT_GRANT_TTL_MS),
    maxCalls: input.maxCalls ?? DEFAULT_GRANT_MAX_CALLS,
    callCount: 0,
    signal: input.signal,
    resolveVerdict: input.resolveVerdict,
  };
  const end = () => endGrant(tokenHash);
  if (input.signal.aborted) return { token, grant, end };
  registry().set(tokenHash, grant);
  input.signal.addEventListener("abort", end, { once: true });
  return { token, grant, end };
}

/** The live grant for a token, or undefined. Expired and aborted grants are deleted on the way. */
export function findGrant(token: string | null | undefined, now: number = Date.now()): ToolGrant | undefined {
  if (!token) return undefined;
  const tokenHash = hashToken(token);
  const grant = registry().get(tokenHash);
  if (!grant) return undefined;
  if (grant.signal.aborted || now >= grant.expiresAt) {
    endGrant(tokenHash);
    return undefined;
  }
  return grant;
}

export function endGrant(tokenHash: string): void {
  registry().delete(tokenHash);
}

/** Number of live grants. For tests and diagnostics. */
export function activeGrantCount(): number {
  return registry().size;
}

function sweep(now: number): void {
  for (const [hash, grant] of registry()) {
    if (grant.signal.aborted || now >= grant.expiresAt) registry().delete(hash);
  }
}
