import { describe, expect, it } from "vitest";
import { createDevinClient, DevinApiError } from "../devin/client";

const KEY = "cog_secret_key_123";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, impl };
}

const session = { session_id: "devin-abc", status: "running", status_detail: "working", structured_output: null, url: "https://app.devin.ai/sessions/abc" };

function problem(status: number, title: string, detail: string): Response {
  return new Response(JSON.stringify({ type: "about:blank", title, status, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

describe("Devin REST client", () => {
  it("builds the right URL, headers and body for each call", async () => {
    const { calls, impl } = fakeFetch((call) =>
      call.url.includes("/messages")
        ? Response.json({ items: [{ event_id: "e1", source: "devin", message: "hi", created_at: "x" }], end_cursor: "c2", has_next_page: false })
        : call.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json(session),
    );
    const client = createDevinClient({ apiKey: KEY, orgId: "org-abc123", fetch: impl });

    const created = await client.createSession({ prompt: "Investigate", title: "GLD investigation inv-1", tags: ["ghost-login-defender"], resumable: false });
    expect(created.session_id).toBe("devin-abc");
    await client.getSession("devin-abc");
    const page = await client.listMessages("devin-abc", { after: "c1", first: 50 });
    expect(page).toEqual({ items: [{ event_id: "e1", source: "devin", message: "hi", created_at: "x" }], end_cursor: "c2", has_next_page: false });
    await client.terminateSession("devin-abc");

    const base = "https://api.devin.ai/v3/organizations/org-abc123";
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${base}/sessions`,
      `GET ${base}/sessions/devin-abc`,
      `GET ${base}/sessions/devin-abc/messages?after=c1&first=50`,
      `DELETE ${base}/sessions/devin-abc`,
    ]);
    for (const call of calls) expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[1].headers["content-type"]).toBeUndefined();
    expect(calls[0].body).toEqual({ prompt: "Investigate", title: "GLD investigation inv-1", tags: ["ghost-login-defender"], resumable: false });
    expect(calls[1].body).toBeUndefined();
  });

  it("honours a custom base URL", async () => {
    const { calls, impl } = fakeFetch(() => Response.json(session));
    const client = createDevinClient({ apiKey: KEY, orgId: "org-x", baseUrl: "https://devin.internal/", fetch: impl });
    await client.getSession("devin-abc");
    expect(calls[0].url).toBe("https://devin.internal/v3/organizations/org-x/sessions/devin-abc");
  });

  it("maps a 401 problem to an error with status and detail, never the key", async () => {
    const { impl } = fakeFetch(() => problem(401, "Unauthorized", `Invalid API key ${KEY}`));
    const client = createDevinClient({ apiKey: KEY, orgId: "org-abc123", fetch: impl });
    const err = await client.createSession({ prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevinApiError);
    const apiErr = err as DevinApiError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.message).toContain("401");
    expect(apiErr.message).toContain("Unauthorized");
    expect(apiErr.message).toContain("Invalid API key");
    expect(apiErr.message).not.toContain(KEY);
    expect(JSON.stringify(apiErr)).not.toContain(KEY);
  });

  it("maps a 429 problem to a rate-limit error", async () => {
    const { impl } = fakeFetch(() => problem(429, "Too Many Requests", "Slow down, retry in 10 seconds"));
    const client = createDevinClient({ apiKey: KEY, orgId: "org-abc123", fetch: impl });
    const err = (await client.getSession("devin-abc").catch((e: unknown) => e)) as DevinApiError;
    expect(err.status).toBe(429);
    expect(err.message).toContain("429");
    expect(err.message).toContain("rate limited");
    expect(err.message).toContain("Slow down, retry in 10 seconds");
    expect(err.message).not.toContain(KEY);
  });

  it("turns a network failure and a malformed answer into plain errors", async () => {
    const broken = createDevinClient({
      apiKey: KEY,
      orgId: "org-abc123",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(broken.getSession("devin-abc")).rejects.toThrow("Devin API request failed: fetch failed");

    const odd = createDevinClient({ apiKey: KEY, orgId: "org-abc123", fetch: (async () => Response.json({ hello: 1 })) as typeof fetch });
    await expect(odd.getSession("devin-abc")).rejects.toThrow("unexpected session response");
  });

  it("times out a request that hangs", async () => {
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const client = createDevinClient({ apiKey: KEY, orgId: "org-abc123", fetch: hanging, timeoutMs: 20 });
    await expect(client.getSession("devin-abc")).rejects.toThrow("timed out");
  });
});
