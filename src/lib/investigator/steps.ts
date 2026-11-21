/**
 * Timeline reporting and the tool-result cache shared by both phases.
 *
 * Every tool call goes through `StepRecorder.call`, so the sink sees a
 * `running` step, then the same step as `ok` or `error`. Successful read
 * results are cached so the fallback can reuse what an engine already fetched.
 */
import type {
  BeneficiaryCheckResult,
  CreateIncidentInput,
  DeviceHistoryResult,
  Incident,
  InvestigationContext,
  InvestigationSink,
  InvestigationStep,
  InvestigationTools,
  PaymentHistoryResult,
  SessionActivityResult,
  SimStatusResult,
  ToolName,
} from "@/lib/types";
import { createIncidentInputSchema, describeZodError } from "./verdict";

export const READ_TOOLS = [
  "get_device_history",
  "get_sim_status",
  "get_session_activity",
  "get_payment_history",
  "check_beneficiary",
] as const satisfies readonly ToolName[];
export type ReadToolName = (typeof READ_TOOLS)[number];

export interface ReadResults {
  get_device_history?: DeviceHistoryResult;
  get_sim_status?: SimStatusResult;
  get_session_activity?: SessionActivityResult;
  get_payment_history?: PaymentHistoryResult;
  check_beneficiary?: BeneficiaryCheckResult;
}

export const NOTE_MAX_CHARS = 280;

export type CallOutcome<T> = { ok: true; output: T } | { ok: false; error: string };

export class StepRecorder {
  private n = 0;
  readonly reads: ReadResults = {};
  incident: Incident | undefined;

  constructor(
    private readonly ctx: InvestigationContext,
    private readonly sink: InvestigationSink,
    private readonly toolTimeoutMs: number,
    /** Once aborted, no tool runs and nothing is reported any more. */
    private readonly signal?: AbortSignal,
  ) {}

  private nextId(): string {
    return `${this.ctx.investigationId}-step-${++this.n}`;
  }

  note(text: string): void {
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    const clipped = clean.length > NOTE_MAX_CHARS ? `${clean.slice(0, NOTE_MAX_CHARS - 3).trimEnd()}...` : clean;
    safely(() =>
      this.sink.stepStarted({ kind: "note", id: this.nextId(), text: clipped, startedAt: this.sink.now() }),
    );
  }

  /**
   * Runs one tool call and reports it. Never throws. `delayMs` keeps the step
   * in the `running` state a little longer so the timeline animates.
   */
  async call<T>(
    tool: ToolName,
    input: Record<string, unknown>,
    run: () => Promise<T>,
    delayMs = 0,
  ): Promise<CallOutcome<T>> {
    if (this.signal?.aborted) return { ok: false, error: CANCELLED };
    const started: InvestigationStep = {
      kind: "tool_call",
      id: this.nextId(),
      tool,
      input,
      status: "running",
      startedAt: this.sink.now(),
    };
    safely(() => this.sink.stepStarted(started));
    if (delayMs > 0) await sleep(delayMs, this.signal);
    if (this.signal?.aborted) return { ok: false, error: CANCELLED };

    let outcome: CallOutcome<T>;
    try {
      outcome = { ok: true, output: await withTimeout(run(), this.toolTimeoutMs, `${tool} timed out`) };
    } catch (err) {
      outcome = { ok: false, error: errorMessage(err) };
    }

    const finishedAt = this.sink.now();
    safely(() =>
      this.sink.stepFinished(
        outcome.ok
          ? { ...started, status: "ok", output: outcome.output, finishedAt }
          : { ...started, status: "error", error: outcome.error, finishedAt },
      ),
    );
    return outcome;
  }

  async read<K extends ReadToolName>(
    tools: InvestigationTools,
    tool: K,
    delayMs = 0,
  ): Promise<CallOutcome<NonNullable<ReadResults[K]>>> {
    const outcome = await this.call(tool, {}, () => tools[tool]() as unknown as Promise<NonNullable<ReadResults[K]>>, delayMs);
    if (outcome.ok) this.reads[tool] = outcome.output;
    return outcome;
  }

  async createIncident(
    tools: InvestigationTools,
    input: CreateIncidentInput,
    delayMs = 0,
  ): Promise<CallOutcome<Incident>> {
    const outcome = await this.call("create_incident", { ...input }, () => tools.create_incident(input), delayMs);
    if (outcome.ok) this.incident = outcome.output;
    return outcome;
  }
}

/**
 * Tools handed to an engine. Calls are reported and cached, `create_incident`
 * input is validated, and once `isOpen()` turns false (time cap fired, or the
 * engine phase ended) every call is refused without touching the real tools.
 */
export function trackedTools(
  real: InvestigationTools,
  recorder: StepRecorder,
  isOpen: () => boolean,
): InvestigationTools {
  const closed = () => new Error("Investigation engine phase has ended; tool call refused");
  const unwrap = <T>(outcome: CallOutcome<T>): T => {
    if (outcome.ok) return outcome.output;
    throw new Error(outcome.error);
  };
  const read =
    <K extends ReadToolName>(tool: K) =>
    async (): Promise<NonNullable<ReadResults[K]>> => {
      if (!isOpen()) throw closed();
      return unwrap(await recorder.read(real, tool));
    };

  return {
    get_device_history: read("get_device_history"),
    get_sim_status: read("get_sim_status"),
    get_session_activity: read("get_session_activity"),
    get_payment_history: read("get_payment_history"),
    check_beneficiary: read("check_beneficiary"),
    async create_incident(input: CreateIncidentInput): Promise<Incident> {
      if (!isOpen()) throw closed();
      const parsed = createIncidentInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = `Invalid create_incident input (${describeZodError(parsed.error)})`;
        unwrap(await recorder.call("create_incident", asRecord(input), () => Promise.reject(new Error(message))));
      }
      return unwrap(await recorder.createIncident(real, parsed.data as CreateIncidentInput));
    },
  };
}

export const CANCELLED = "Investigation cancelled";

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  return text.trim().slice(0, 200) || "unknown error";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** The sink belongs to the bank core; a broken sink must not break the investigation. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignored on purpose
  }
}
