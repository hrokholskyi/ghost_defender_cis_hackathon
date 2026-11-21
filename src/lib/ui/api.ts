/** Browser client for the simulator API. Never throws; every call returns a result. */
import type {
  PaymentResponse,
  ScenarioId,
  ScenarioNextResponse,
  StateSnapshot,
  VerificationResponse,
} from "@/lib/types";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string };

const TIMEOUT_MS = 4000;

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: json as T };
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    return { ok: false, status: res.status, code: err?.code ?? "HTTP_ERROR", message: err?.message ?? res.statusText };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return { ok: false, status: 0, code: "NETWORK", message: aborted ? "Request timed out" : "Backend unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  state: () => call<StateSnapshot>("GET", "/api/state"),
  startScenario: (id: ScenarioId) => call<StateSnapshot>("POST", `/api/scenarios/${id}/start`),
  nextStep: () => call<ScenarioNextResponse>("POST", "/api/scenarios/next"),
  respond: (verificationId: string, response: "CONFIRM" | "DENY", token: string) =>
    call<VerificationResponse>("POST", `/api/verifications/${encodeURIComponent(verificationId)}/respond`, { response }, token),
  execute: (paymentId: string, token: string) =>
    call<PaymentResponse>("POST", `/api/payments/${encodeURIComponent(paymentId)}/execute`, undefined, token),
};

/** "403 SESSION_RESTRICTED: Session sess-002 is restricted" */
export function describeError(r: { status: number; code: string; message: string }): string {
  if (r.status === 0) return r.message;
  return `${r.status} ${r.code}: ${r.message}`;
}
