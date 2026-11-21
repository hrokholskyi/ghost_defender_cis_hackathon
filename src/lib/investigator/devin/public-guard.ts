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

/** Hostname of the public URL (no port), normalised, or null when unset or unparseable. */
function publicHostOf(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return normalizeHost(new URL(value).hostname) || null;
  } catch {
    return null;
  }
}

/**
 * Hostname only: lower case, any port removed, trailing dots removed. The
 * port is ignored on purpose: Cloudflare also serves HTTPS on 8443, 2053,
 * 2083, 2087 and 2096, and a port must never make the public host look private.
 */
export function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[")) {
    // IPv6 literal, for example [::1]:3000.
    const end = host.indexOf("]");
    host = end >= 0 ? host.slice(0, end + 1) : host;
  } else if (host.split(":").length === 2) {
    host = host.slice(0, host.indexOf(":"));
  }
  return host.replace(/\.+$/, "");
}
