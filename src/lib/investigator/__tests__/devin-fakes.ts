import type {
  CreateSessionBody,
  DevinClient,
  DevinMessagesPage,
  DevinSession,
} from "../devin/client";
import type { Sleep } from "../devin/engine";
import { handleToolRequest } from "../devin/tool-endpoint";

export const PUBLIC_URL = "https://gld-demo.example.test";

export const GOOD_VERDICT = {
  assessment: "LIKELY_ACCOUNT_TAKEOVER",
  summary:
    "A new Android device logged in 45 minutes after a SIM swap and sent 28.3x the typical amount to a payee added in the same session. The payment should stay held.",
  evidence: ["Unknown device Galaxy A54", "SIM swapped 45 minutes before login", "Beneficiary added in this session"],
  recommendedAction: "HOLD_AND_RESTRICT",
};

type Scripted<T> = T | Error;

export interface FakeDevinClient extends DevinClient {
  created: CreateSessionBody[];
  getCalls: number;
  messageCalls: Array<{ after?: string; first?: number }>;
  terminated: string[];
  /** Resolves with the prompt once createSession was called. */
  sessionCreated: Promise<string>;
}

export interface FakeDevinOptions {
  create?: Scripted<DevinSession>;
  /** Consumed one per poll. When empty, the session keeps running. */
  polls?: Array<Scripted<Partial<DevinSession>>>;
  /** Consumed one per listMessages call. When empty, an empty page. */
  messages?: Array<Scripted<DevinMessagesPage>>;
  /** Runs after createSession returns, like the Devin machine would. */
  onCreated?: (prompt: string) => void | Promise<void>;
}

export function fakeDevinClient(options: FakeDevinOptions = {}): FakeDevinClient {
  const polls = [...(options.polls ?? [])];
  const messages = [...(options.messages ?? [])];
  let announce: (prompt: string) => void = () => undefined;
  const sessionCreated = new Promise<string>((resolve) => {
    announce = resolve;
  });

  const client: FakeDevinClient = {
    created: [],
    getCalls: 0,
    messageCalls: [],
    terminated: [],
    sessionCreated,
    async createSession(body) {
      client.created.push(body);
      const result = options.create ?? { session_id: "devin-abc123", status: "new", url: "https://app.devin.ai/sessions/abc123" };
      if (result instanceof Error) throw result;
      announce(body.prompt);
      if (options.onCreated) setTimeout(() => void options.onCreated?.(body.prompt), 0);
      return result;
    },
    async getSession(sessionId) {
      client.getCalls += 1;
      const next = polls.shift() ?? { status: "running", status_detail: "working" };
      if (next instanceof Error) throw next;
      return { session_id: sessionId, status: "running", structured_output: null, ...next };
    },
    async listMessages(_id, page = {}) {
      client.messageCalls.push(page);
      const next = messages.shift() ?? { items: [], end_cursor: null, has_next_page: false };
      if (next instanceof Error) throw next;
      return next;
    },
    async terminateSession(sessionId) {
      client.terminated.push(sessionId);
    },
  };
  return client;
}

export function tokenFrom(prompt: string): string {
  const match = /Authorization: Bearer ([A-Za-z0-9_-]+)/.exec(prompt);
  if (!match) throw new Error("no token in prompt");
  return match[1];
}

/** Calls our tool endpoint the way the Devin machine would. */
export async function callTool(tool: string, token: string | null, body?: unknown, method = "POST"): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(`${PUBLIC_URL}/api/investigations/tools/${tool}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return handleToolRequest(request, tool);
}

/** A well-behaved Devin: reads all five tools, opens an incident, submits the verdict. */
export async function behaveLikeDevin(prompt: string, verdict: unknown = GOOD_VERDICT): Promise<void> {
  const token = tokenFrom(prompt);
  await Promise.all(
    ["get_device_history", "get_sim_status", "get_session_activity", "get_payment_history", "check_beneficiary"].map((t) =>
      callTool(t, token),
    ),
  );
  await callTool("create_incident", token, { title: "Suspected account takeover", severity: "CRITICAL", reasons: ["SIM swap"] });
  await callTool("submit_verdict", token, verdict);
}

/** Sleep that never resolves on its own; it only rejects on abort. Polling never advances. */
export const neverSleep: Sleep = (_ms, signal) =>
  new Promise<void>((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** Sleep that resolves at once, so every poll happens immediately. */
export const instantSleep: Sleep = async (_ms, signal) => {
  if (signal.aborted) throw signal.reason;
};
