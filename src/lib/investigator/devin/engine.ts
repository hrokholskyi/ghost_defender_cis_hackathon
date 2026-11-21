/**
 * Devin engine: runs one investigation as a Devin session.
 *
 * 1. Issue a one-time tool grant for the investigation.
 * 2. Start a Devin session with a prompt that carries ready-to-run curl
 *    commands for the tool endpoints and the grant token.
 * 3. Wait for the verdict on two channels, first one wins: submit_verdict on
 *    our endpoint (instant), or the session's structured output (polling).
 * 4. End the grant whatever happens. On failure or abort, terminate the
 *    session best-effort; on success leave it so it can be opened and shown.
 *
 * The engine only returns a raw verdict. The orchestrator validates it, owns
 * the time cap and falls back to the deterministic investigator on any throw.
 */
import { errorMessage } from "../steps";
import type { EngineRunInput, LlmEngine } from "../engine";
import type { DevinClient, DevinSession } from "./client";
import { createGrant, DEFAULT_GRANT_MAX_CALLS, DEFAULT_GRANT_TTL_MS } from "./grants";
import { buildDevinPrompt, VERDICT_JSON_SCHEMA } from "./prompt";

export const DEVIN_SESSION_TAG = "ghost-login-defender";
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
/** Upper bound on the best-effort terminate call. */
export const TERMINATE_TIMEOUT_MS = 3_000;
const MAX_FAILED_POLLS = 3;
const MAX_WAITING_POLLS = 2;
const MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGES = 4;

/** Resolves after `ms`, rejects as soon as `signal` aborts. Must clear its timer either way. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface DevinEngineOptions {
  client: DevinClient;
  /** Public base URL of this app, without a trailing slash. */
  publicUrl: string;
  mode?: string;
  maxAcu?: number;
  pollIntervalMs?: number;
  grantTtlMs?: number;
  maxToolCalls?: number;
  sleep?: Sleep;
}

export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function devinModelLabel(mode?: string): string {
  return mode ? `Devin (${mode})` : "Devin";
}

export function createDevinEngine(options: DevinEngineOptions): LlmEngine {
  const { client, publicUrl } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? abortableSleep;

  return {
    id: "devin",
    model: devinModelLabel(options.mode),
    async run({ ctx, tools, note, signal }: EngineRunInput): Promise<unknown> {
      // `local` ends everything this run started: polling, the grant, pending client calls.
      const local = new AbortController();
      const forwardAbort = () => local.abort(signal.reason);
      if (signal.aborted) throw new Error("investigation was cancelled before Devin started");
      signal.addEventListener("abort", forwardAbort, { once: true });

      let submitted: { raw: unknown } | undefined;
      let onSubmit: (raw: unknown) => void = () => undefined;
      const submittedVerdict = new Promise<unknown>((resolve) => {
        onSubmit = resolve;
      });
      const grant = createGrant({
        investigationId: ctx.investigationId,
        tools,
        signal: local.signal,
        ttlMs: options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS,
        maxCalls: options.maxToolCalls ?? DEFAULT_GRANT_MAX_CALLS,
        resolveVerdict: (raw) => {
          if (submitted) return;
          submitted = { raw };
          onSubmit(raw);
        },
      });

      let sessionId: string | undefined;
      let succeeded = false;
      try {
        let session: DevinSession;
        try {
          session = await client.createSession(
            {
              prompt: buildDevinPrompt({ ctx, publicUrl, token: grant.token }),
              title: `GLD investigation ${ctx.investigationId}`,
              tags: [DEVIN_SESSION_TAG],
              structured_output_schema: VERDICT_JSON_SCHEMA,
              structured_output_required: true,
              resumable: false,
              ...(options.mode ? { devin_mode: options.mode } : {}),
              ...(options.maxAcu !== undefined ? { max_acu_limit: options.maxAcu } : {}),
            },
            local.signal,
          );
        } catch (err) {
          throw new Error(`could not start a Devin session: ${errorMessage(err)}`);
        }
        sessionId = session.session_id;
        note(session.url ? `Devin session started: ${session.url}` : `Devin session started: ${sessionId}`);
        if (local.signal.aborted) throw new Error("Devin run was cancelled");

        const aborted = new Promise<never>((_, reject) => {
          local.signal.addEventListener("abort", () => reject(new Error("Devin run was cancelled")), { once: true });
        });
        const polled = pollForVerdict({
          client,
          sessionId,
          note,
          signal: local.signal,
          sleep,
          pollIntervalMs,
          submitted: () => submitted,
        });
        // Losing branches reject when `local` aborts below; keep those rejections handled.
        aborted.catch(() => undefined);
        polled.catch(() => undefined);

        const verdict = await Promise.race([submittedVerdict, polled, aborted]);
        succeeded = true;
        return verdict;
      } finally {
        signal.removeEventListener("abort", forwardAbort);
        grant.end();
        if (!local.signal.aborted) local.abort(new Error("Devin run settled"));
        if (!succeeded && sessionId) await terminateQuietly(client, sessionId);
      }
    },
  };
}

interface PollInput {
  client: DevinClient;
  sessionId: string;
  note(text: string): void;
  signal: AbortSignal;
  sleep: Sleep;
  pollIntervalMs: number;
  submitted(): { raw: unknown } | undefined;
}

async function pollForVerdict(input: PollInput): Promise<unknown> {
  const { client, sessionId, signal } = input;
  const relay = messageRelay(client, sessionId, input.note, signal);
  let failedPolls = 0;
  let waitingPolls = 0;

  for (;;) {
    await input.sleep(input.pollIntervalMs, signal);

    let session: DevinSession;
    try {
      session = await client.getSession(sessionId, signal);
      failedPolls = 0;
    } catch (err) {
      if (signal.aborted) throw err;
      failedPolls += 1;
      if (failedPolls >= MAX_FAILED_POLLS) {
        throw new Error(`lost contact with the Devin session after ${MAX_FAILED_POLLS} failed status checks (${errorMessage(err)})`);
      }
      continue;
    }

    await relay();
    if (signal.aborted) throw new Error("Devin run was cancelled");

    // A verdict that arrived on the endpoint meanwhile wins over anything the status says.
    const submitted = input.submitted();
    if (submitted) return submitted.raw;

    const output = session.structured_output ?? null;
    const detail = session.status_detail ?? null;
    const finished = detail === "finished" || session.status === "exit";
    const waiting = detail === "waiting_for_user" || detail === "waiting_for_approval";

    if (output !== null && (finished || waiting)) return output;
    if (session.status === "error") throw new Error(`Devin session ended with an error${detail ? ` (${detail})` : ""}`);
    if (session.status === "suspended") throw new Error(`Devin session was suspended (${detail ?? "no reason given"})`);
    if (finished) throw new Error("Devin session finished without a verdict");
    if (waiting) {
      waitingPolls += 1;
      if (waitingPolls >= MAX_WAITING_POLLS) {
        throw new Error(`Devin session is stuck ${detail === "waiting_for_user" ? "waiting for user input" : "waiting for approval"}`);
      }
    } else {
      waitingPolls = 0;
    }
  }
}

/** Passes new Devin messages to `note`, once each. Failures are ignored. */
function messageRelay(client: DevinClient, sessionId: string, note: (text: string) => void, signal: AbortSignal) {
  const seen = new Set<string>();
  let cursor: string | undefined;
  return async () => {
    try {
      for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
        const result = await client.listMessages(sessionId, { after: cursor, first: MESSAGE_PAGE_SIZE }, signal);
        for (const item of result.items) {
          if (seen.has(item.event_id)) continue;
          seen.add(item.event_id);
          if (item.source === "devin" && item.message.trim()) note(item.message);
        }
        if (result.end_cursor) cursor = result.end_cursor;
        if (!result.has_next_page || !result.end_cursor) break;
      }
    } catch {
      // Narration is optional; the verdict does not depend on it.
    }
  };
}

/** Best-effort: never throws, never takes longer than TERMINATE_TIMEOUT_MS. */
async function terminateQuietly(client: DevinClient, sessionId: string): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("terminate timed out"));
      resolve();
    }, TERMINATE_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.terminateSession(sessionId, controller.signal).catch(() => undefined), cap]);
  } finally {
    clearTimeout(timer);
  }
}
