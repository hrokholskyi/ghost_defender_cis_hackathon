import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/investigations/tools/[tool]/route";
import { activeGrantCount, createGrant, type IssuedGrant } from "../devin/grants";
import { handleToolRequest, TOOL_BODY_LIMIT_BYTES } from "../devin/tool-endpoint";
import { callTool, GOOD_VERDICT, PUBLIC_URL } from "./devin-fakes";
import { fakeTools, type FakeTools } from "./fixtures";

const issued: IssuedGrant[] = [];
const controllers: AbortController[] = [];

function grant(options: { ttlMs?: number; maxCalls?: number; tools?: FakeTools } = {}) {
  const controller = new AbortController();
  controllers.push(controller);
  const tools = options.tools ?? fakeTools();
  const verdicts: unknown[] = [];
  const g = createGrant({
    investigationId: "inv-1",
    tools,
    signal: controller.signal,
    ttlMs: options.ttlMs,
    maxCalls: options.maxCalls,
    resolveVerdict: (raw) => verdicts.push(raw),
  });
  issued.push(g);
  return { ...g, tools, verdicts, controller };
}

afterEach(() => {
  for (const g of issued.splice(0)) g.end();
  for (const c of controllers.splice(0)) c.abort();
  vi.useRealTimers();
});

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("Devin tool endpoint - method check", () => {
  it("answers 405 for a wrong method without counting the call against the cap", async () => {
    const g = grant({ maxCalls: 2 });
    for (let i = 0; i < 5; i++) {
      expect((await callTool("get_sim_status", g.token, undefined, "DELETE")).status).toBe(405);
      expect((await callTool("submit_verdict", g.token, undefined, "GET")).status).toBe(405);
    }
    expect(g.grant.callCount).toBe(0);
    expect((await callTool("get_sim_status", g.token)).status).toBe(200);
    expect((await callTool("check_beneficiary", g.token)).status).toBe(200);
    expect((await callTool("get_device_history", g.token)).status).toBe(429);
  });
});

describe("Devin tool endpoint", () => {
  it("runs a read tool for a valid token and returns its result", async () => {
    const g = grant();
    const res = await callTool("get_sim_status", g.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toEqual({
      tool: "get_sim_status",
      result: { available: true, source: "synthetic-telco-signal", swapConfirmed: true, swappedAt: "2026-03-01T01:15:00.000Z", minutesBeforeLogin: 45 },
    });
    // GET works for read tools too.
    expect((await callTool("check_beneficiary", g.token, undefined, "GET")).status).toBe(200);
    expect(g.tools.calls).toEqual(["get_sim_status", "check_beneficiary"]);
  });

  it("answers 404 for unknown tool names and executes nothing", async () => {
    const g = grant();
    for (const name of ["release_payment", "__proto__", "constructor", "toString", "execute_payment", "GET_SIM_STATUS"]) {
      const res = await callTool(name, g.token, {});
      expect(res.status, name).toBe(404);
      expect(await body(res)).toEqual({ error: { code: "NOT_FOUND", message: "Unknown tool" } });
    }
    expect(g.tools.calls).toEqual([]);
  });

  it("gives the same 401 for missing, wrong, expired and ended tokens", async () => {
    const live = grant();
    const expired = grant({ ttlMs: 5 });
    const ended = grant();
    ended.end();
    const aborted = grant();
    aborted.controller.abort();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1_000);

    const responses = [
      await callTool("get_sim_status", null),
      await callTool("get_sim_status", "not-a-real-token"),
      await callTool("get_sim_status", expired.token),
      await callTool("get_sim_status", ended.token),
      await callTool("get_sim_status", aborted.token),
    ];
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]).error.code).toBe("UNAUTHENTICATED");
    // Unknown tools are not revealed to unauthenticated callers either.
    expect((await callTool("release_payment", null)).status).toBe(401);
    for (const g of [expired, ended, aborted]) expect(g.tools.calls).toEqual([]);
    expect((await callTool("get_sim_status", live.token)).status).toBe(200);
  });

  it("enforces the call cap per grant", async () => {
    const g = grant({ maxCalls: 3 });
    for (let i = 0; i < 3; i += 1) expect((await callTool("get_device_history", g.token)).status).toBe(200);
    const refused = await callTool("get_device_history", g.token);
    expect(refused.status).toBe(429);
    expect((await body(refused)).error).toMatchObject({ code: "CALL_LIMIT_REACHED" });
    expect(g.tools.calls).toHaveLength(3);
  });

  it("answers 400 on invalid JSON and 413 on an oversized body", async () => {
    const g = grant();
    const bad = await callTool("create_incident", g.token, "{not json");
    expect(bad.status).toBe(400);
    expect((await body(bad)).error).toEqual({ code: "INVALID_REQUEST", message: "Request body is not valid JSON" });

    const big = await callTool("submit_verdict", g.token, { summary: "x".repeat(TOOL_BODY_LIMIT_BYTES + 10) });
    expect(big.status).toBe(413);
    expect(g.tools.calls).toEqual([]);
    expect(g.verdicts).toEqual([]);
  });

  it("refuses GET for create_incident and submit_verdict", async () => {
    const g = grant();
    const res = await callTool("submit_verdict", g.token, undefined, "GET");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("passes the create_incident body through to the tracked tool", async () => {
    const create = vi.fn(fakeTools().create_incident);
    const g = grant({ tools: fakeTools({ create_incident: create }) });
    const input = { title: "Suspected account takeover", severity: "CRITICAL", reasons: ["SIM swap", "New device"] };
    const res = await callTool("create_incident", g.token, input);
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(input);
    expect(await body(res)).toMatchObject({ tool: "create_incident", result: { id: "INC-0001", title: input.title } });
  });

  it("answers 502 when a tool fails and lets the session continue", async () => {
    const g = grant({ tools: fakeTools({ get_sim_status: async () => Promise.reject(new Error("telco signal unreachable")) }) });
    const res = await callTool("get_sim_status", g.token);
    expect(res.status).toBe(502);
    expect(await body(res)).toEqual({ error: { code: "TOOL_FAILED", message: "telco signal unreachable" } });
    expect((await callTool("get_device_history", g.token)).status).toBe(200);
  });

  it("submit_verdict hands the raw body to the engine and ends the grant", async () => {
    const g = grant();
    const before = activeGrantCount();

    const invalid = await callTool("submit_verdict", g.token, { ...GOOD_VERDICT, recommendedAction: "RELEASE" });
    expect(invalid.status).toBe(400);
    expect((await body(invalid)).error).toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("recommendedAction") });
    expect(g.verdicts).toEqual([]);

    const res = await callTool("submit_verdict", g.token, GOOD_VERDICT);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ accepted: true });
    expect(g.verdicts).toEqual([GOOD_VERDICT]);
    expect(activeGrantCount()).toBe(before - 1);

    const again = await callTool("submit_verdict", g.token, GOOD_VERDICT);
    expect(again.status).toBe(401);
    expect((await callTool("get_sim_status", g.token)).status).toBe(401);
    expect(g.verdicts).toHaveLength(1);
  });

  it("is wired into the route handler for GET and POST", async () => {
    const g = grant();
    const params = { params: Promise.resolve({ tool: "get_payment_history" }) };
    const make = (method: string) =>
      new Request(`${PUBLIC_URL}/api/investigations/tools/get_payment_history`, { method, headers: { authorization: `Bearer ${g.token}` } });
    expect((await GET(make("GET"), params)).status).toBe(200);
    expect((await POST(make("POST"), params)).status).toBe(200);
    expect((await handleToolRequest(make("POST"), "get_payment_history")).status).toBe(200);
    expect(g.tools.calls).toEqual(["get_payment_history", "get_payment_history", "get_payment_history"]);
  });
});
