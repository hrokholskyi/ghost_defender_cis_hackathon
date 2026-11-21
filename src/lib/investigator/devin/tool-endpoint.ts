/**
 * HTTP face of the investigation tools, called by the Devin session.
 *
 * `POST|GET /api/investigations/tools/{tool}` with `Authorization: Bearer <grant token>`.
 * The route file only forwards here, so this is testable without Next.
 *
 * Safety rules:
 * - Tool names are a closed list in a Map. User input never selects a property.
 * - Missing, unknown, expired and ended tokens get the same 401.
 * - Read tools and create_incident run the grant's tracked tools, so every call
 *   shows up on the dashboard timeline by itself.
 * - Nothing here can move, release or block money.
 */
import { bearerToken, readTextLimited } from "@/lib/http";
import type { InvestigationTools } from "@/lib/types";
import { errorMessage } from "../steps";
import { describeZodError, submittedVerdictSchema } from "../verdict";
import { endGrant, findGrant, type ToolGrant } from "./grants";

export const TOOL_BODY_LIMIT_BYTES = 16 * 1024;

export const DEVIN_TOOL_NAMES = [
  "get_device_history",
  "get_sim_status",
  "get_session_activity",
  "get_payment_history",
  "check_beneficiary",
  "create_incident",
  "submit_verdict",
] as const;
export type DevinToolName = (typeof DEVIN_TOOL_NAMES)[number];

type ToolSpec =
  | { kind: "read"; run: (tools: InvestigationTools) => Promise<unknown> }
  | { kind: "create_incident" }
  | { kind: "submit_verdict" };

const TOOL_TABLE: ReadonlyMap<string, ToolSpec> = new Map<DevinToolName, ToolSpec>([
  ["get_device_history", { kind: "read", run: (t) => t.get_device_history() }],
  ["get_sim_status", { kind: "read", run: (t) => t.get_sim_status() }],
  ["get_session_activity", { kind: "read", run: (t) => t.get_session_activity() }],
  ["get_payment_history", { kind: "read", run: (t) => t.get_payment_history() }],
  ["check_beneficiary", { kind: "read", run: (t) => t.check_beneficiary() }],
  ["create_incident", { kind: "create_incident" }],
  ["submit_verdict", { kind: "submit_verdict" }],
]);

const HEADERS = { "Cache-Control": "no-store" };

function reply(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

function fail(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return reply({ error: { code, message } }, status, extra);
}

const unauthenticated = () =>
  fail(401, "UNAUTHENTICATED", "Missing or invalid investigation token. Your access has ended; stop calling tools.");

export interface ToolEndpointOptions {
  now?: () => number;
}

export async function handleToolRequest(request: Request, toolName: string, options: ToolEndpointOptions = {}): Promise<Response> {
  const now = options.now ?? Date.now;
  const grant = findGrant(bearerToken(request), now());
  if (!grant) return unauthenticated();

  const spec = TOOL_TABLE.get(toolName);
  if (!spec) return fail(404, "NOT_FOUND", "Unknown tool");

  // The method is checked first, so a wrong method does not use up a call.
  const method = request.method.toUpperCase();
  if (spec.kind === "read") {
    if (method !== "GET" && method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "Use GET or POST", { Allow: "GET, POST" });
  } else if (method !== "POST") {
    return fail(405, "METHOD_NOT_ALLOWED", "Use POST", { Allow: "POST" });
  }

  if (grant.callCount >= grant.maxCalls) {
    return fail(429, "CALL_LIMIT_REACHED", "Tool call limit reached for this investigation. Submit your verdict with what you have.");
  }
  grant.callCount += 1;

  if (spec.kind === "read") return runTool(toolName, () => spec.run(grant.tools));

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  if (spec.kind === "create_incident") {
    return runTool(toolName, () => grant.tools.create_incident(body.value as Parameters<InvestigationTools["create_incident"]>[0]));
  }
  return submitVerdict(grant, body.value);
}

async function runTool(tool: string, run: () => Promise<unknown>): Promise<Response> {
  try {
    return reply({ tool, result: await run() });
  } catch (err) {
    return fail(502, "TOOL_FAILED", errorMessage(err));
  }
}

/**
 * The shape is checked here as well as in the orchestrator, so Devin gets a
 * 400 it can fix instead of a failed investigation. The grant stays open until
 * a well-formed verdict arrives; the raw body is what the engine receives.
 */
function submitVerdict(grant: ToolGrant, raw: unknown): Response {
  const parsed = submittedVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(400, "INVALID_REQUEST", `Invalid verdict (${describeZodError(parsed.error)}). Fix it and submit again.`);
  }
  if (grant.signal.aborted) return unauthenticated();
  endGrant(grant.tokenHash);
  grant.resolveVerdict(raw);
  return reply({ accepted: true });
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJsonBody(request: Request): Promise<BodyResult> {
  const text = await readTextLimited(request, TOOL_BODY_LIMIT_BYTES);
  if (text === null) return tooLarge();
  if (!text.trim()) return { ok: false, response: fail(400, "INVALID_REQUEST", "Request body must be a JSON object") };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: fail(400, "INVALID_REQUEST", "Request body is not valid JSON") };
  }
}

function tooLarge(): BodyResult {
  return { ok: false, response: fail(413, "PAYLOAD_TOO_LARGE", `Request body is larger than ${TOOL_BODY_LIMIT_BYTES} bytes`) };
}
