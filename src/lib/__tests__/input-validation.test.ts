import { beforeEach, describe, expect, it } from "vitest";
import { POST as postBeneficiary } from "@/app/api/beneficiaries/route";
import { POST as postLogin } from "@/app/api/login/route";
import { POST as postPayment } from "@/app/api/payments/route";
import { POST as postSimSwap } from "@/app/api/sim-swap/route";
import { GET as getState } from "@/app/api/state/route";
import { advanceClock, nowMs, setClock } from "@/lib/clock";
import { whenIdle } from "@/lib/investigations";
import { getState as store } from "@/lib/store";
import type { ApiError, LoginResponse, PaymentResponse, StateSnapshot } from "@/lib/types";
import { freshStore } from "./helpers";

beforeEach(freshStore);

const BASE = "http://localhost:3000";
const HOME = { ip: "10.0.0.2", city: "Dubai", country: "AE" };

function req(path: string, options: { body?: unknown; raw?: string; token?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.body !== undefined || options.raw !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return new Request(`${BASE}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

async function read<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

async function state(): Promise<StateSnapshot> {
  return read<StateSnapshot>(await getState(req("/api/state", { method: "GET" })), 200);
}

async function iphoneLogin(): Promise<LoginResponse> {
  return read<LoginResponse>(await postLogin(req("/api/login", { body: { deviceId: "dev-iphone", network: HOME } })), 200);
}

const BAD_AT = [
  "Mar 15 2099",
  "+275760-09-13T00:00:00Z",
  "2026-03-15T25:00:00+04:00",
  "2026-03-15",
  "2026-03-15T10:00:00",
  "2150-01-01T00:00:00Z",
  "1970-01-01T00:00:00Z",
];

describe("simulated timestamps", () => {
  it("a malformed or out-of-range `at` on a payment is a 400 and does not move the clock", async () => {
    const { session } = await iphoneLogin();
    const before = (await state()).now;
    for (const at of BAD_AT) {
      const res = await read<ApiError>(
        await postPayment(req("/api/payments", { token: session.token, body: { beneficiaryId: "ben-alnoor", amount: 100, at } })),
        400,
      );
      expect(res.error.code, at).toBe("INVALID_REQUEST");
      expect((await state()).now, at).toBe(before);
    }
    await whenIdle();
  });

  it("a restricted session's bad `at` does not move the clock either", async () => {
    const { session } = await iphoneLogin();
    store().sessions.find((s) => s.id === session.id)!.status = "RESTRICTED";
    const before = (await state()).now;
    for (const at of BAD_AT) {
      const res = await read<ApiError>(
        await postPayment(req("/api/payments", { token: session.token, body: { beneficiaryId: "ben-alnoor", amount: 100, at } })),
        403,
      );
      expect(res.error.code).toBe("SESSION_RESTRICTED");
      expect((await state()).now, at).toBe(before);
    }
    // A valid `at` still moves it.
    await postPayment(req("/api/payments", { token: session.token, body: { at: "2026-03-15T11:00:00+04:00" } }));
    expect((await state()).now).toBe("2026-03-15T11:00:00+04:00");
  });

  it("every route that takes `at` rejects bad values and keeps GET /api/state working", async () => {
    const { session } = await iphoneLogin();
    const before = (await state()).now;
    for (const at of BAD_AT) {
      expect((await postLogin(req("/api/login", { body: { deviceId: "dev-iphone", network: HOME, at } }))).status, at).toBe(400);
      expect((await postSimSwap(req("/api/sim-swap", { body: { swappedAt: "2026-03-15T08:00:00+04:00", at } }))).status, at).toBe(400);
      expect((await postSimSwap(req("/api/sim-swap", { body: { swappedAt: at } }))).status, at).toBe(400);
      expect(
        (await postBeneficiary(req("/api/beneficiaries", { token: session.token, body: { name: "X Co", iban: "AE00 DEMO 0000 0000 0000 999", at } })))
          .status,
        at,
      ).toBe(400);
      const s = await state();
      expect(s.now, at).toBe(before);
      expect(s.sim.swapConfirmed).toBe(false);
    }
  });

  it("accepts ISO timestamps with Z, an offset or milliseconds", async () => {
    for (const at of ["2026-03-15T09:10:00Z", "2026-03-15T13:20:00+04:00", "2026-03-15T13:30:00.250+04:00", "2026-03-15T13:40+04:00"]) {
      expect((await postLogin(req("/api/login", { body: { deviceId: "dev-iphone", network: HOME, at } }))).status, at).toBe(200);
    }
    expect((await state()).now).toBe("2026-03-15T13:40:00+04:00");
  });

  it("the clock itself refuses non-finite and out-of-range values", () => {
    const before = nowMs();
    expect(() => advanceClock("+275760-09-13T00:00:00Z")).toThrow();
    expect(() => advanceClock("2150-01-01T00:00:00Z")).toThrow();
    expect(() => advanceClock("garbage")).toThrow();
    expect(() => setClock("+275760-09-13T00:00:00Z")).toThrow();
    expect(() => setClock("garbage")).toThrow();
    expect(nowMs()).toBeGreaterThanOrEqual(before);
    expect(nowMs()).toBeLessThan(before + 60_000);
  });
});

describe("transfer amounts", () => {
  it("rejects sub-cent amounts and keeps the balance", async () => {
    const { session } = await iphoneLogin();
    for (const amount of [0.004, 0.001, 10.005, 1e-9]) {
      const res = await read<ApiError>(
        await postPayment(req("/api/payments", { token: session.token, body: { beneficiaryId: "ben-alnoor", amount } })),
        400,
      );
      expect(res.error.code, String(amount)).toBe("INVALID_REQUEST");
    }
    expect((await state()).customer.balance).toBe(92000);
    expect((await state()).payments.filter((p) => !p.historical)).toHaveLength(0);
  });

  it("rejects amounts above the upper bound", async () => {
    const { session } = await iphoneLogin();
    expect(
      (await postPayment(req("/api/payments", { token: session.token, body: { beneficiaryId: "ben-alnoor", amount: 10_000_000.01 } }))).status,
    ).toBe(400);
  });

  it("accepts whole cents, including float sums like 0.1 + 0.2", async () => {
    const { session } = await iphoneLogin();
    const paid = await read<PaymentResponse>(
      await postPayment(req("/api/payments", { token: session.token, body: { beneficiaryId: "ben-alnoor", amount: 1234.56 } })),
      200,
    );
    expect(paid.payment.status).toBe("SETTLED");
    expect(paid.balance).toBe(90765.44);
    const sum = await read<PaymentResponse>(
      await postPayment(req("/api/payments", { token: session.token, body: { beneficiaryId: "ben-alnoor", amount: 0.1 + 0.2 } })),
      200,
    );
    expect(sum.payment.status).toBe("SETTLED");
    expect(sum.balance).toBe(90765.14);
  });
});

describe("refused transfers and request bodies", () => {
  it("a refused transfer from a restricted session does not store unvalidated fields", async () => {
    const { session } = await iphoneLogin();
    store().sessions.find((s) => s.id === session.id)!.status = "RESTRICTED";
    const junk = { beneficiaryId: "x".repeat(5000), amount: -1e308 };
    expect((await postPayment(req("/api/payments", { token: session.token, body: junk }))).status).toBe(403);
    const rejected = (await state()).payments.find((p) => p.status === "REJECTED")!;
    expect(rejected.beneficiaryId).toBe("");
    expect(rejected.amount).toBe(0);

    const valid = { beneficiaryId: "ben-alnoor", amount: 250 };
    expect((await postPayment(req("/api/payments", { token: session.token, body: valid }))).status).toBe(403);
    const second = (await state()).payments.filter((p) => p.status === "REJECTED")[1];
    expect(second).toMatchObject({ beneficiaryId: "ben-alnoor", amount: 250 });
  });

  it("refuses request bodies over 16 KB", async () => {
    const big = JSON.stringify({ deviceId: "dev-iphone", network: HOME, pad: "x".repeat(17 * 1024) });
    const res = await read<ApiError>(await postLogin(req("/api/login", { raw: big })), 400);
    expect(res.error.code).toBe("INVALID_REQUEST");
    expect(res.error.message).toContain("16");
    expect((await state()).sessions).toHaveLength(0);
  });
});
