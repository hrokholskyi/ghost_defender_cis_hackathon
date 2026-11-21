/**
 * Minimal typed client for the Devin API v3 (organization scope).
 *
 * Only the four calls the investigator needs. Every call has its own timeout,
 * and errors carry the HTTP status and the RFC 9457 problem title and detail,
 * never the API key.
 */
import { z } from "zod";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type DevinSessionStatus = "new" | "claimed" | "running" | "exit" | "error" | "suspended" | "resuming";

export interface CreateSessionBody {
  prompt: string;
  title?: string;
  tags?: string[];
  structured_output_schema?: Record<string, unknown>;
  structured_output_required?: boolean;
  resumable?: boolean;
  devin_mode?: string;
  max_acu_limit?: number;
}

export interface DevinSession {
  session_id: string;
  /** One of DevinSessionStatus; kept open so a new status does not break parsing. */
  status: string;
  status_detail?: string | null;
  structured_output?: unknown;
  url?: string | null;
}

export interface DevinMessage {
  event_id: string;
  source: string;
  message: string;
  created_at?: string;
}

export interface DevinMessagesPage {
  items: DevinMessage[];
  end_cursor: string | null;
  has_next_page: boolean;
}

export interface DevinClient {
  createSession(body: CreateSessionBody, signal?: AbortSignal): Promise<DevinSession>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<DevinSession>;
  listMessages(sessionId: string, page?: { after?: string; first?: number }, signal?: AbortSignal): Promise<DevinMessagesPage>;
  terminateSession(sessionId: string, signal?: AbortSignal): Promise<void>;
}

export interface DevinClientOptions {
  apiKey: string;
  orgId: string;
  /** Default https://api.devin.ai. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class DevinApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly title?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DevinApiError";
  }
}

const sessionSchema = z
  .object({
    session_id: z.string().min(1),
    status: z.string(),
    status_detail: z.string().nullish(),
    structured_output: z.unknown().optional(),
    url: z.string().nullish(),
  })
  .loose();

const messagesSchema = z
  .object({
    items: z.array(
      z
        .object({
          event_id: z.string(),
          source: z.string(),
          message: z.string(),
          created_at: z.string().optional(),
        })
        .loose(),
    ),
    end_cursor: z.string().nullish(),
    has_next_page: z.boolean().optional(),
  })
  .loose();

const problemSchema = z.object({ title: z.string().optional(), detail: z.string().optional() }).loose();

export function createDevinClient(options: DevinClientOptions): DevinClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const base = `${(options.baseUrl ?? "https://api.devin.ai").replace(/\/+$/, "")}/v3/organizations/${encodeURIComponent(options.orgId)}`;
  const redact = (text: string) => (options.apiKey ? text.split(options.apiKey).join("[redacted]") : text);

  async function request(method: string, path: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) throw new DevinApiError("Devin API request cancelled", null);
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, timeoutMs);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";

      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(`${base}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          cache: "no-store",
        });
        text = await response.text();
      } catch (err) {
        if (timedOut) {
          const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
          throw new DevinApiError(`Devin API request timed out after ${limit}`, null);
        }
        if (signal?.aborted) throw new DevinApiError("Devin API request cancelled", null);
        const reason = err instanceof Error ? err.message : "network error";
        throw new DevinApiError(redact(`Devin API request failed: ${reason}`), null);
      }

      if (!response.ok) throw problemError(response, text, redact);
      if (!text.trim()) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        throw new DevinApiError(`Devin API returned invalid JSON (HTTP ${response.status})`, response.status);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new DevinApiError(`Devin API returned an unexpected ${what} response`, null);
    return parsed.data;
  }

  const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;

  return {
    async createSession(body, signal) {
      return parse(sessionSchema, await request("POST", "/sessions", body, signal), "create session");
    },
    async getSession(sessionId, signal) {
      return parse(sessionSchema, await request("GET", sessionPath(sessionId), undefined, signal), "session");
    },
    async listMessages(sessionId, page = {}, signal) {
      const query = new URLSearchParams();
      if (page.after) query.set("after", page.after);
      if (page.first !== undefined) query.set("first", String(page.first));
      const qs = query.toString() ? `?${query.toString()}` : "";
      const data = parse(messagesSchema, await request("GET", `${sessionPath(sessionId)}/messages${qs}`, undefined, signal), "messages");
      return { items: data.items, end_cursor: data.end_cursor ?? null, has_next_page: data.has_next_page ?? false };
    },
    async terminateSession(sessionId, signal) {
      await request("DELETE", sessionPath(sessionId), undefined, signal);
    },
  };
}

function problemError(response: Response, text: string, redact: (s: string) => string): DevinApiError {
  let title: string | undefined;
  let detail: string | undefined;
  try {
    const problem = problemSchema.safeParse(JSON.parse(text));
    if (problem.success) {
      title = problem.data.title;
      detail = problem.data.detail;
    }
  } catch {
    // not JSON; status alone is enough
  }
  title = clip(redact(title ?? response.statusText ?? ""));
  detail = detail ? clip(redact(detail)) : undefined;
  const label = response.status === 429 ? "rate limited" : title || "request failed";
  const message = `Devin API error ${response.status} (${label}${detail ? `: ${detail}` : ""})`;
  return new DevinApiError(message, response.status, title || undefined, detail);
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 140 ? `${clean.slice(0, 137)}...` : clean;
}
