/**
 * Public-exposure guard decision, used by src/proxy.ts.
 *
 * When the app is reachable through GLD_PUBLIC_URL (a tunnel for Devin), only
 * the investigation tool endpoints may be public. The simulator routes are not:
 * /api/state returns session tokens. Requests on any other host (localhost)
 * are untouched. GLD_PUBLIC_DASHBOARD=1 opens everything on purpose.
 */
import type { InvestigatorEnv } from "../config";

export const PUBLIC_TOOL_PATH = /^\/api\/investigations\/tools\/[A-Za-z0-9_]+\/?$/;

export interface GuardRequest {
  pathname: string;
  host: string | null;
  forwardedHost: string | null;
}

export type GuardDecision = "allow" | "block";

export function publicGuardDecision(env: InvestigatorEnv, request: GuardRequest): GuardDecision {
  const publicHost = publicHostOf(env.GLD_PUBLIC_URL);
  if (!publicHost) return "allow";
  if (env.GLD_PUBLIC_DASHBOARD?.trim() === "1") return "allow";

  const candidates = [request.host, ...(request.forwardedHost ?? "").split(",")]
    .map((h) => normalizeHost(h ?? ""))
    .filter(Boolean);
  const isPublic = candidates.includes(publicHost);
  if (!isPublic) return "allow";
  return PUBLIC_TOOL_PATH.test(request.pathname) ? "allow" : "block";
}

/** Host (with a non-default port) of the public URL, lower case, or null when unset or unparseable. */
function publicHostOf(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return normalizeHost(new URL(value).host) || null;
  } catch {
    return null;
  }
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "").replace(/:(80|443)$/, "");
}
