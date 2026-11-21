/** Thin helpers for route handlers: JSON in, JSON out, domain errors to ApiError. */
import { DomainError } from "@/lib/errors";
import type { ApiError } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    const body: ApiError = { error: { code: error.code, message: error.message } };
    return json(body, error.status);
  }
  console.error("Unhandled route error", error);
  return Response.json({ error: { code: "INTERNAL", message: "Internal error" } }, { status: 500, headers: NO_STORE });
}

/** `Authorization: Bearer <token>` or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export const JSON_BODY_LIMIT_BYTES = 16 * 1024;

/** The body as text, or null once it passes `limit` bytes. Stops reading at the limit. */
export async function readTextLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Parses the JSON body. An empty body is `{}`. Malformed JSON or a body over 16 KB is a 400. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await readTextLimited(request, JSON_BODY_LIMIT_BYTES);
  if (text === null) {
    throw new DomainError("INVALID_REQUEST", `Request body is larger than ${JSON_BODY_LIMIT_BYTES / 1024} KB`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("INVALID_REQUEST", "Request body is not valid JSON");
  }
}

/**
 * Runs a handler and maps errors. Reading the request headers first keeps
 * every route dynamic: with Cache Components, `export const dynamic` is not
 * available, and a GET that touches the request is never prerendered.
 */
export async function handle(request: Request, fn: () => unknown | Promise<unknown>): Promise<Response> {
  void request.headers.get("authorization");
  try {
    return json(await fn());
  } catch (error) {
    return errorResponse(error);
  }
}
