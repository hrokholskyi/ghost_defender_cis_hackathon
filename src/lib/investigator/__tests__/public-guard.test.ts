import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { publicGuardDecision } from "../devin/public-guard";

const ENV = { GLD_PUBLIC_URL: "https://Gld-Demo.trycloudflare.com/" };
const PUBLIC = "gld-demo.trycloudflare.com";

const at = (pathname: string, host: string | null, forwardedHost: string | null = null) => ({ pathname, host, forwardedHost });

describe("public-exposure guard", () => {
  it("allows only the tool endpoints on the public host", () => {
    expect(publicGuardDecision(ENV, at("/api/investigations/tools/get_sim_status", PUBLIC))).toBe("allow");
    expect(publicGuardDecision(ENV, at("/api/investigations/tools/submit_verdict", PUBLIC.toUpperCase()))).toBe("allow");
    for (const path of ["/api/state", "/", "/api/payments", "/api/reset", "/api/investigations/tools", "/api/investigations/tools/a/b", "/_next/static/chunk.js"]) {
      expect(publicGuardDecision(ENV, at(path, PUBLIC)), path).toBe("block");
    }
    expect(publicGuardDecision(ENV, at("/api/state", `${PUBLIC}:443`))).toBe("block");
  });

  it("leaves localhost and other hosts untouched", () => {
    for (const path of ["/api/state", "/", "/api/payments"]) {
      expect(publicGuardDecision(ENV, at(path, "localhost:3000"))).toBe("allow");
      expect(publicGuardDecision(ENV, at(path, "127.0.0.1:3000"))).toBe("allow");
    }
  });

  it("honours x-forwarded-host from a tunnel", () => {
    expect(publicGuardDecision(ENV, at("/api/state", "localhost:3000", PUBLIC))).toBe("block");
    expect(publicGuardDecision(ENV, at("/api/state", "localhost:3000", `proxy.internal, ${PUBLIC.toUpperCase()}`))).toBe("block");
    expect(publicGuardDecision(ENV, at("/api/investigations/tools/check_beneficiary", "localhost:3000", PUBLIC))).toBe("allow");
  });

  it("GLD_PUBLIC_DASHBOARD=1 opens everything", () => {
    const env = { ...ENV, GLD_PUBLIC_DASHBOARD: "1" };
    expect(publicGuardDecision(env, at("/api/state", PUBLIC))).toBe("allow");
    expect(publicGuardDecision(env, at("/", PUBLIC))).toBe("allow");
  });

  it("does not block anything without GLD_PUBLIC_URL", () => {
    expect(publicGuardDecision({}, at("/api/state", PUBLIC))).toBe("allow");
    expect(publicGuardDecision({ GLD_PUBLIC_URL: "  " }, at("/api/state", PUBLIC))).toBe("allow");
  });

  it("proxy answers 404 on the public host and passes through elsewhere", async () => {
    const previous = process.env.GLD_PUBLIC_URL;
    process.env.GLD_PUBLIC_URL = ENV.GLD_PUBLIC_URL;
    try {
      const blocked = proxy(new NextRequest(`https://${PUBLIC}/api/state`, { headers: { host: PUBLIC } }));
      expect(blocked.status).toBe(404);
      expect(await blocked.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });

      const tool = proxy(new NextRequest(`https://${PUBLIC}/api/investigations/tools/get_sim_status`, { headers: { host: PUBLIC } }));
      expect(tool.headers.get("x-middleware-next")).toBe("1");

      const local = proxy(new NextRequest("http://localhost:3000/api/state", { headers: { host: "localhost:3000" } }));
      expect(local.headers.get("x-middleware-next")).toBe("1");
    } finally {
      if (previous === undefined) delete process.env.GLD_PUBLIC_URL;
      else process.env.GLD_PUBLIC_URL = previous;
    }
  });
});
