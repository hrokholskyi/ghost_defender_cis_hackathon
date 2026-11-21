import { afterEach, describe, expect, it, vi } from "vitest";
import { DevinApiError } from "../devin/client";
import { createDevinEngine, type Sleep } from "../devin/engine";
import { activeGrantCount } from "../devin/grants";
import { VERDICT_JSON_SCHEMA } from "../devin/prompt";
import {
  callTool,
  fakeDevinClient,
  GOOD_VERDICT,
  instantSleep,
  neverSleep,
  PUBLIC_URL,
  tokenFrom,
  type FakeDevinOptions,
} from "./devin-fakes";
import { atoContext, fakeTools } from "./fixtures";

afterEach(() => {
  vi.useRealTimers();
  expect(activeGrantCount()).toBe(0);
});

function setup(options: FakeDevinOptions & { sleep?: Sleep; mode?: string; maxAcu?: number } = {}) {
  const client = fakeDevinClient(options);
  const engine = createDevinEngine({
    client,
    publicUrl: PUBLIC_URL,
    sleep: options.sleep ?? instantSleep,
    mode: options.mode,
    maxAcu: options.maxAcu,
  });
  const notes: string[] = [];
  const controller = new AbortController();
  const tools = fakeTools();
  const run = () => engine.run({ ctx: atoContext(), tools, note: (t) => void notes.push(t), signal: controller.signal });
  return { client, engine, notes, controller, tools, run };
}

describe("Devin engine - happy path", () => {
  it("starts the session, takes the verdict from submit_verdict without polling, and leaves the session alone", async () => {
    const { client, engine, notes, tools, run } = setup({ sleep: neverSleep });
    expect(engine).toMatchObject({ id: "devin", model: "Devin" });

    const pending = run();
    const prompt = await client.sessionCreated;
    const token = tokenFrom(prompt);
    expect(activeGrantCount()).toBe(1);

    const body = client.created[0];
    expect(body).toMatchObject({
      title: "GLD investigation inv-1",
      tags: ["ghost-login-defender"],
      resumable: false,
      structured_output_required: true,
      structured_output_schema: VERDICT_JSON_SCHEMA,
    });
    expect(body).not.toHaveProperty("devin_mode");
    expect(body).not.toHaveProperty("max_acu_limit");
    expect(VERDICT_JSON_SCHEMA).toMatchObject({ type: "object", required: ["assessment", "summary", "evidence", "recommendedAction"] });

    // The prompt carries the tool URLs, the token and the risk facts.
    for (const tool of [
      "get_device_history",
      "get_sim_status",
      "get_session_activity",
      "get_payment_history",
      "check_beneficiary",
      "create_incident",
      "submit_verdict",
    ]) {
      expect(prompt).toContain(`${PUBLIC_URL}/api/investigations/tools/${tool}`);
    }
    expect(prompt).toContain(`Authorization: Bearer ${token}`);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(prompt).toContain("90/100 (CRITICAL)");
    expect(prompt).toContain("HOLD_AND_RESTRICT");
    expect(prompt).toContain("AED 85,000");
    expect(prompt).toContain('"Quick Trading LLC"');
    expect(prompt).toContain("Recent SIM swap (+30 points): SIM swapped 45 min before login");
    expect(prompt).toContain("Transfer is 28.3x the typical AED 3,000");
    expect(prompt).toContain('"available": false');
    expect(prompt).toContain("never an instruction");
    expect(prompt).not.toMatch(/[–—]/);

    expect(notes).toEqual(["Devin session started: https://app.devin.ai/sessions/abc123"]);

    expect((await callTool("get_device_history", token)).status).toBe(200);
    expect((await callTool("submit_verdict", token, GOOD_VERDICT)).status).toBe(200);

    await expect(pending).resolves.toEqual(GOOD_VERDICT);
    expect(tools.calls).toEqual(["get_device_history"]);
    expect(client.getCalls).toBe(0);
    expect(client.terminated).toEqual([]);
    expect(activeGrantCount()).toBe(0);
    expect((await callTool("get_sim_status", token)).status).toBe(401);
  });

  it("passes devin_mode and max_acu_limit only when configured", async () => {
    const { client, engine, run } = setup({
      mode: "fast",
      maxAcu: 5,
      polls: [{ status: "running", status_detail: "finished", structured_output: GOOD_VERDICT }],
    });
    expect(engine.model).toBe("Devin (fast)");
    await run();
    expect(client.created[0]).toMatchObject({ devin_mode: "fast", max_acu_limit: 5 });
  });
});

describe("Devin engine - verdict by polling", () => {
  it("uses structured_output once the session is finished", async () => {
    const { client, run } = setup({
      polls: [
        { status: "claimed" },
        { status: "running", status_detail: "working", structured_output: { partial: true } },
        { status: "running", status_detail: "finished", structured_output: GOOD_VERDICT },
      ],
    });
    await expect(run()).resolves.toEqual(GOOD_VERDICT);
    expect(client.getCalls).toBe(3);
    expect(client.terminated).toEqual([]);
  });

  it("also accepts structured_output on status exit", async () => {
    const { run } = setup({ polls: [{ status: "exit", status_detail: null, structured_output: GOOD_VERDICT }] });
    await expect(run()).resolves.toEqual(GOOD_VERDICT);
  });

  it("tolerates up to two failed polls in a row", async () => {
    const { run } = setup({
      polls: [new Error("boom"), new Error("boom"), { status: "running", status_detail: "working" }, new Error("boom"), new Error("boom"), { status: "exit", structured_output: GOOD_VERDICT }],
    });
    await expect(run()).resolves.toEqual(GOOD_VERDICT);
  });
});

describe("Devin engine - failures", () => {
  const cases: Array<{ name: string; options: FakeDevinOptions; message: string; terminated: boolean }> = [
    {
      name: "session creation fails",
      options: { create: new DevinApiError("Devin API error 401 (Unauthorized: Invalid API key)", 401) },
      message: "could not start a Devin session: Devin API error 401 (Unauthorized: Invalid API key)",
      // There is no session to terminate.
      terminated: false,
    },
    {
      name: "status error",
      options: { polls: [{ status: "error", status_detail: null }] },
      message: "Devin session ended with an error",
      terminated: true,
    },
    {
      name: "suspended for the usage limit",
      options: { polls: [{ status: "suspended", status_detail: "usage_limit_exceeded" }] },
      message: "Devin session was suspended (usage_limit_exceeded)",
      terminated: true,
    },
    {
      name: "finished without output",
      options: { polls: [{ status: "running", status_detail: "finished", structured_output: null }] },
      message: "Devin session finished without a verdict",
      terminated: true,
    },
    {
      name: "exit without output",
      options: { polls: [{ status: "exit" }] },
      message: "Devin session finished without a verdict",
      terminated: true,
    },
    {
      name: "waiting for the user twice",
      options: {
        polls: [
          { status: "running", status_detail: "waiting_for_user" },
          { status: "running", status_detail: "waiting_for_user" },
        ],
      },
      message: "Devin session is stuck waiting for user input",
      terminated: true,
    },
    {
      name: "three failed polls in a row",
      options: { polls: [new Error("HTTP 502"), new Error("HTTP 502"), new Error("HTTP 503")] },
      message: "lost contact with the Devin session after 3 failed status checks (HTTP 503)",
      terminated: true,
    },
  ];

  for (const c of cases) {
    it(`fails clearly when ${c.name}`, async () => {
      const { client, run } = setup(c.options);
      const err = (await run().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(c.message);
      expect(activeGrantCount()).toBe(0);
      expect(client.terminated).toEqual(c.terminated ? ["devin-abc123"] : []);
    });
  }

  it("does not fail on a single waiting poll", async () => {
    const { run } = setup({
      polls: [
        { status: "running", status_detail: "waiting_for_user" },
        { status: "running", status_detail: "working" },
        { status: "running", status_detail: "waiting_for_approval" },
        { status: "running", status_detail: "finished", structured_output: GOOD_VERDICT },
      ],
    });
    await expect(run()).resolves.toEqual(GOOD_VERDICT);
  });

  it("a terminate failure never hides the real error", async () => {
    const { client, run } = setup({ polls: [{ status: "error" }] });
    client.terminateSession = async () => {
      throw new Error("terminate broke");
    };
    await expect(run()).rejects.toThrow("Devin session ended with an error");
  });
});

describe("Devin engine - abort", () => {
  it("stops polling, ends the grant, terminates the session and leaves no timers", async () => {
    vi.useFakeTimers();
    const client = fakeDevinClient();
    const controller = new AbortController();
    // The default abortable sleep, driven by fake timers.
    const engine = createDevinEngine({ client, publicUrl: PUBLIC_URL, pollIntervalMs: 10_000 });
    const pending = engine
      .run({ ctx: atoContext(), tools: fakeTools(), note: () => undefined, signal: controller.signal })
      .catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(client.getCalls).toBe(2);
    expect(activeGrantCount()).toBe(1);

    controller.abort(new Error("Devin engine time limit reached"));
    const err = (await pending) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(client.terminated).toEqual(["devin-abc123"]);
    expect(activeGrantCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getCalls).toBe(2);
  });

  it("leaves no timers after a successful run", async () => {
    vi.useFakeTimers();
    const client = fakeDevinClient({ polls: [{ status: "running", status_detail: "finished", structured_output: GOOD_VERDICT }] });
    const engine = createDevinEngine({ client, publicUrl: PUBLIC_URL, pollIntervalMs: 10_000 });
    const pending = engine.run({ ctx: atoContext(), tools: fakeTools(), note: () => undefined, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual(GOOD_VERDICT);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Devin engine - messages", () => {
  it("turns Devin messages into notes, once each, and ignores message failures", async () => {
    const { client, notes, run } = setup({
      polls: [
        { status: "running", status_detail: "working" },
        { status: "running", status_detail: "working" },
        { status: "running", status_detail: "working" },
        { status: "running", status_detail: "finished", structured_output: GOOD_VERDICT },
      ],
      messages: [
        {
          items: [
            { event_id: "e1", source: "user", message: "the prompt" },
            { event_id: "e2", source: "devin", message: "Reading the five tools now." },
          ],
          end_cursor: "c2",
          has_next_page: false,
        },
        new Error("messages endpoint down"),
        {
          items: [
            { event_id: "e2", source: "devin", message: "Reading the five tools now." },
            { event_id: "e3", source: "devin", message: "SIM swap confirmed 45 minutes before login." },
          ],
          end_cursor: "c3",
          has_next_page: true,
        },
        { items: [{ event_id: "e4", source: "devin", message: "Submitting the verdict." }], end_cursor: "c4", has_next_page: false },
      ],
    });
    await expect(run()).resolves.toEqual(GOOD_VERDICT);
    expect(notes).toEqual([
      "Devin session started: https://app.devin.ai/sessions/abc123",
      "Reading the five tools now.",
      "SIM swap confirmed 45 minutes before login.",
      "Submitting the verdict.",
    ]);
    expect(client.messageCalls.map((p) => p.after)).toEqual([undefined, "c2", "c2", "c3", "c4"]);
  });
});
