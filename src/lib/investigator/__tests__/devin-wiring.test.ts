import { afterEach, describe, expect, it, vi } from "vitest";
import { createInvestigator, getLlmStatus, investigatorFromEnv } from "../index";
import { DevinApiError, type DevinClientOptions } from "../devin/client";
import { createDevinEngine } from "../devin/engine";
import { activeGrantCount } from "../devin/grants";
import { FORCED_FALLBACK_REASON } from "../orchestrator";
import { behaveLikeDevin, fakeDevinClient, neverSleep, PUBLIC_URL } from "./devin-fakes";
import { atoContext, fakeTools, recordingSink, toolSteps } from "./fixtures";

afterEach(() => {
  expect(activeGrantCount()).toBe(0);
});

const ALL = { DEVIN_API_KEY: "cog_test", DEVIN_ORG_ID: "org-abc123", GLD_PUBLIC_URL: `${PUBLIC_URL}/` };

describe("Devin engine through createInvestigator", () => {
  it("happy path: Devin calls the tools over HTTP and its verdict wins", async () => {
    const client = fakeDevinClient({ onCreated: (prompt) => behaveLikeDevin(prompt) });
    const engine = createDevinEngine({ client, publicUrl: PUBLIC_URL, sleep: neverSleep });
    const sink = recordingSink();
    const result = await createInvestigator({ env: {}, engine })(atoContext(), fakeTools(), sink, { stepDelayMs: 0 });

    expect(result.engine).toBe("devin");
    expect(result.model).toBe("Devin");
    expect(result.fallbackReason).toBeUndefined();
    expect(result.verdict).toMatchObject({ assessment: "LIKELY_ACCOUNT_TAKEOVER", recommendedAction: "HOLD_AND_RESTRICT", incidentId: "INC-0001" });
    expect(sink.engines).toEqual([{ engine: "devin", model: "Devin" }]);
    expect(toolSteps(sink).map((s) => [s.tool, s.status])).toEqual([
      ["get_device_history", "ok"],
      ["get_sim_status", "ok"],
      ["get_session_activity", "ok"],
      ["get_payment_history", "ok"],
      ["check_beneficiary", "ok"],
      ["create_incident", "ok"],
    ]);
    const notes = sink.steps().filter((s) => s.kind === "note");
    expect(notes.map((n) => n.kind === "note" && n.text)).toEqual(["Devin session started: https://app.devin.ai/sessions/abc123"]);
    expect(client.terminated).toEqual([]);
  });

  it("a failing Devin client gives the deterministic fallback with a reason naming the cause", async () => {
    const client = fakeDevinClient({ create: new DevinApiError("Devin API error 429 (rate limited: Slow down)", 429) });
    const engine = createDevinEngine({ client, publicUrl: PUBLIC_URL, sleep: neverSleep });
    const sink = recordingSink();
    const result = await createInvestigator({ env: {}, engine })(atoContext(), fakeTools(), sink, { stepDelayMs: 0 });

    expect(result.engine).toBe("deterministic-fallback");
    expect(result.fallbackReason).toBe("Devin engine failed: could not start a Devin session: Devin API error 429 (rate limited: Slow down)");
    expect(result.verdict.incidentId).toBe("INC-0001");
    expect(sink.engines.map((e) => e.engine)).toEqual(["devin", "deterministic-fallback"]);
  });

  it("the time cap aborts Devin, terminates the session and falls back", async () => {
    const client = fakeDevinClient();
    const engine = createDevinEngine({ client, publicUrl: PUBLIC_URL, sleep: neverSleep });
    const result = await createInvestigator({ env: {}, engine, engineTimeoutMs: 30 })(atoContext(), fakeTools(), recordingSink(), {
      stepDelayMs: 0,
    });
    expect(result.engine).toBe("deterministic-fallback");
    expect(result.fallbackReason).toBe("Devin engine did not finish within 30 ms");
    await vi.waitFor(() => expect(client.terminated).toEqual(["devin-abc123"]));
  });
});

describe("Devin configuration from env", () => {
  it("getLlmStatus reports Devin only when key, org id and public URL are set and fallback is not forced", () => {
    expect(getLlmStatus({})).toEqual({ configured: false, model: null });
    expect(getLlmStatus({ DEVIN_API_KEY: "cog_test" })).toEqual({ configured: false, model: null });
    expect(getLlmStatus(ALL)).toEqual({ configured: true, model: "Devin" });
    expect(getLlmStatus({ ...ALL, GLD_DEVIN_MODE: "fast" })).toEqual({ configured: true, model: "Devin (fast)" });
    expect(getLlmStatus({ ...ALL, GLD_FORCE_FALLBACK: "1" })).toEqual({ configured: false, model: null });
  });

  async function runWith(env: Record<string, string>) {
    const created: DevinClientOptions[] = [];
    const client = fakeDevinClient({ onCreated: (prompt) => behaveLikeDevin(prompt) });
    const run = investigatorFromEnv(env, {
      createClient: (options) => {
        created.push(options);
        return client;
      },
      sleep: neverSleep,
    });
    const result = await run(atoContext(), fakeTools(), recordingSink(), { stepDelayMs: 0 });
    return { result, created, client };
  }

  it("names exactly what is missing", async () => {
    const none = await runWith({});
    expect(none.result).toMatchObject({
      engine: "deterministic-fallback",
      fallbackReason: "Devin not configured: set DEVIN_API_KEY, DEVIN_ORG_ID and GLD_PUBLIC_URL",
    });
    expect(none.created).toEqual([]);

    const keyOnly = await runWith({ DEVIN_API_KEY: "cog_test" });
    expect(keyOnly.result.fallbackReason).toBe("Devin not configured: set DEVIN_ORG_ID and GLD_PUBLIC_URL");

    const noUrl = await runWith({ DEVIN_API_KEY: "cog_test", DEVIN_ORG_ID: "org-abc123" });
    expect(noUrl.result.fallbackReason).toBe("Devin not configured: set GLD_PUBLIC_URL");

    const badUrl = await runWith({ ...ALL, GLD_PUBLIC_URL: "not a url" });
    expect(badUrl.result.fallbackReason).toContain("GLD_PUBLIC_URL must be a plain http(s) URL");
  });

  it("runs Devin when all three are set, with the env settings", async () => {
    const { result, created, client } = await runWith({ ...ALL, GLD_DEVIN_MODE: "fast", GLD_DEVIN_MAX_ACU: "3" });
    expect(result).toMatchObject({ engine: "devin", model: "Devin (fast)" });
    expect(created).toEqual([{ apiKey: "cog_test", orgId: "org-abc123", baseUrl: "https://api.devin.ai" }]);
    expect(client.created[0]).toMatchObject({ devin_mode: "fast", max_acu_limit: 3 });
    // The trailing slash of GLD_PUBLIC_URL is dropped.
    expect(client.created[0].prompt).toContain(`${PUBLIC_URL}/api/investigations/tools/get_sim_status`);
  });

  it("forced fallback wins over a full Devin configuration", async () => {
    const { result, created } = await runWith({ ...ALL, GLD_FORCE_FALLBACK: "1" });
    expect(result).toMatchObject({ engine: "deterministic-fallback", fallbackReason: FORCED_FALLBACK_REASON });
    expect(created).toEqual([]);
  });

  it("rejects bad optional values with a clear reason", async () => {
    expect((await runWith({ ...ALL, GLD_DEVIN_MAX_ACU: "-2" })).result.fallbackReason).toBe(
      "Devin not configured: GLD_DEVIN_MAX_ACU must be a positive integer",
    );
    expect((await runWith({ ...ALL, GLD_DEVIN_MODE: "Fast Mode!" })).result.fallbackReason).toContain("GLD_DEVIN_MODE");
  });
});
