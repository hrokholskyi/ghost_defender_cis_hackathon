import { beforeEach, describe, expect, it } from "vitest";
import { POST as postBeneficiary } from "@/app/api/beneficiaries/route";
import { POST as postLogin } from "@/app/api/login/route";
import { POST as postExecute } from "@/app/api/payments/[id]/execute/route";
import { POST as postPayment } from "@/app/api/payments/route";
import { POST as postReset } from "@/app/api/reset/route";
import { POST as postScenarioStart } from "@/app/api/scenarios/[id]/start/route";
import { POST as postScenarioNext } from "@/app/api/scenarios/next/route";
import { POST as postSimSwap } from "@/app/api/sim-swap/route";
import { GET as getState } from "@/app/api/state/route";
import { POST as postRespond } from "@/app/api/verifications/[id]/respond/route";
import { whenIdle } from "@/lib/investigations";
import type {
  AddBeneficiaryRequest,
  ApiError,
  LoginResponse,
  PaymentResponse,
  ScenarioNextResponse,
  StateSnapshot,
  VerificationResponse,
} from "@/lib/types";
import { freshStore } from "./helpers";

beforeEach(freshStore);

const BASE = "http://localhost:3000";

function req(path: string, options: { body?: unknown; token?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return new Request(`${BASE}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function read<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as T;
}

async function state(): Promise<StateSnapshot> {
  return read<StateSnapshot>(await getState(req("/api/state", { method: "GET" })), 200);
}

describe("API routes - scenario B through the HTTP layer", () => {
  it("drives the scenario and refuses every bypass", async () => {
    const started = await read<StateSnapshot>(await postScenarioStart(req("/api/scenarios/b/start"), params("b")), 200);
    expect(started.scenario).toEqual({ id: "B", nextStep: 0, totalSteps: 4, actorSessionId: null });
    expect(started.scenarios.map((x) => x.id)).toEqual(["A", "B", "C"]);
    expect(started.riskConfig.disclaimer).toBe("Demo weights and thresholds. Not a calibrated model.");
    expect(started.llm).toEqual({ configured: false, model: null });

    const scores: number[] = [];
    let last: ScenarioNextResponse | undefined;
    for (let i = 0; i < 4; i++) {
      last = await read<ScenarioNextResponse>(await postScenarioNext(req("/api/scenarios/next")), 200);
      scores.push(last.state.risk[last.scenario.actorSessionId!].score);
    }
    expect(scores).toEqual([15, 40, 55, 90]);
    expect(last!.step.type).toBe("TRANSFER");
    expect(last!.scenario.nextStep).toBe(4);

    const finished = await read<ApiError>(await postScenarioNext(req("/api/scenarios/next")), 409);
    expect(finished.error.code).toBe("CONFLICT");

    let s = await state();
    const attacker = s.sessions.find((x) => x.id === s.scenario!.actorSessionId)!;
    const iphone = s.sessions.find((x) => x.deviceId === "dev-iphone")!;
    const held = s.payments.find((p) => p.sessionId === attacker.id)!;
    expect(held.status).toBe("HELD");
    expect(attacker.status).toBe("RESTRICTED");
    expect(s.customer.balance).toBe(92000);

    // Retry from the restricted session: 403, still held.
    const retry = await read<ApiError>(await postExecute(req(`/api/payments/${held.id}/execute`, { token: attacker.token }), params(held.id)), 403);
    expect(retry.error.code).toBe("SESSION_RESTRICTED");
    expect(typeof retry.error.message).toBe("string");

    // New transfer from the restricted session: 403.
    const again = await read<ApiError>(
      await postPayment(req("/api/payments", { token: attacker.token, body: { beneficiaryId: held.beneficiaryId, amount: 500 } })),
      403,
    );
    expect(again.error.code).toBe("SESSION_RESTRICTED");

    // Adding a beneficiary from the restricted session: 403.
    const ben: AddBeneficiaryRequest = { name: "Mule LLC", iban: "AE00 DEMO 0000 1111 2222 333" };
    expect((await postBeneficiary(req("/api/beneficiaries", { token: attacker.token, body: ben }))).status).toBe(403);

    // No token, unknown token.
    expect((await postPayment(req("/api/payments", { body: { beneficiaryId: "x", amount: 1 } }))).status).toBe(401);
    expect((await postExecute(req(`/api/payments/${held.id}/execute`, { token: "nope" }), params(held.id))).status).toBe(401);

    // The iPhone does not own the held payment.
    const notOwned = await read<ApiError>(
      await postExecute(req(`/api/payments/${held.id}/execute`, { token: iphone.token }), params(held.id)),
      404,
    );
    expect(notOwned.error.code).toBe("NOT_FOUND");

    // The attacker cannot answer the push.
    const verification = s.verifications.find((v) => v.paymentId === held.id)!;
    const forged = await read<ApiError>(
      await postRespond(req(`/api/verifications/${verification.id}/respond`, { token: attacker.token, body: { response: "CONFIRM" } }), params(verification.id)),
      403,
    );
    expect(forged.error.code).toBe("NOT_TRUSTED_CHANNEL");

    await whenIdle();
    s = await state();
    expect(s.payments.find((p) => p.id === held.id)?.status).toBe("HELD");
    expect(s.customer.balance).toBe(92000);
    expect(s.investigations[0].status).toBe("COMPLETED");
    expect(s.incidents[0].status).toBe("OPEN");
    expect(s.audit.filter((e) => e.action === "HOLD_BYPASS_ATTEMPT")).toHaveLength(1);

    // The real customer denies on the trusted iPhone.
    const denied = await read<VerificationResponse>(
      await postRespond(req(`/api/verifications/${verification.id}/respond`, { token: iphone.token, body: { response: "DENY" } }), params(verification.id)),
      200,
    );
    expect(denied.payment.status).toBe("CANCELLED");
    expect(denied.verification.status).toBe("DENIED");
    expect(denied.balance).toBe(92000);

    const twice = await read<ApiError>(
      await postRespond(req(`/api/verifications/${verification.id}/respond`, { token: iphone.token, body: { response: "DENY" } }), params(verification.id)),
      409,
    );
    expect(twice.error.code).toBe("CONFLICT");

    const revoked = await read<ApiError>(
      await postExecute(req(`/api/payments/${held.id}/execute`, { token: attacker.token }), params(held.id)),
      403,
    );
    expect(revoked.error.code).toBe("SESSION_REVOKED");

    s = await state();
    expect(s.incidents[0].status).toBe("CONFIRMED_ATO");
    expect(s.sessions.find((x) => x.id === attacker.id)?.status).toBe("REVOKED");
  });

  it("returns 409 PAYMENT_HELD when an active session retries a held payment", async () => {
    await read<StateSnapshot>(await postReset(req("/api/reset")), 200);
    const login = await read<LoginResponse>(
      await postLogin(
        req("/api/login", {
          body: {
            deviceId: "dev-android-x",
            device: { label: "Samsung Galaxy A54", platform: "Android" },
            network: { ip: "10.88.14.207", city: "Dubai", country: "AE" },
            at: "2026-03-15T10:00:00+04:00",
          },
        }),
      ),
      200,
    );
    expect(login.risk.score).toBe(15);
    expect(login.session.status).toBe("ACTIVE");

    const sim = await read<{ sim: { swapConfirmed: boolean } }>(
      await postSimSwap(req("/api/sim-swap", { body: { swappedAt: "2026-03-15T09:30:00+04:00", at: "2026-03-15T10:01:00+04:00" } })),
      200,
    );
    expect(sim.sim.swapConfirmed).toBe(true);

    const paid = await read<PaymentResponse>(
      await postPayment(
        req("/api/payments", { token: login.session.token, body: { beneficiaryId: "ben-alnoor", amount: 20000, at: "2026-03-15T10:30:00+04:00" } }),
      ),
      200,
    );
    expect(paid.risk.score).toBe(60);
    expect(paid.risk.action).toBe("HOLD");
    expect(paid.payment.status).toBe("HELD");
    expect(paid.balance).toBe(92000);

    const retry = await read<ApiError>(
      await postExecute(req(`/api/payments/${paid.payment.id}/execute`, { token: login.session.token }), params(paid.payment.id)),
      409,
    );
    expect(retry.error.code).toBe("PAYMENT_HELD");
    const s = await state();
    expect(s.payments.find((p) => p.id === paid.payment.id)?.status).toBe("HELD");
    expect(s.audit.some((e) => e.action === "HOLD_BYPASS_ATTEMPT")).toBe(true);
    await whenIdle();
  });

  it("validates input and reports unknown resources", async () => {
    const bad = await read<ApiError>(await postLogin(req("/api/login", { body: { deviceId: "" } })), 400);
    expect(bad.error.code).toBe("INVALID_REQUEST");
    const unknownDevice = await read<ApiError>(
      await postLogin(req("/api/login", { body: { deviceId: "dev-new", network: { ip: "1", city: "Dubai", country: "AE" } } })),
      400,
    );
    expect(unknownDevice.error.code).toBe("INVALID_REQUEST");
    const scenario = await read<ApiError>(await postScenarioStart(req("/api/scenarios/z/start"), params("z")), 400);
    expect(scenario.error.code).toBe("INVALID_REQUEST");

    const login = await read<LoginResponse>(
      await postLogin(req("/api/login", { body: { deviceId: "dev-iphone", network: { ip: "1", city: "Dubai", country: "AE" } } })),
      200,
    );
    const badAmount = await read<ApiError>(
      await postPayment(req("/api/payments", { token: login.session.token, body: { beneficiaryId: "ben-alnoor", amount: -5 } })),
      400,
    );
    expect(badAmount.error.code).toBe("INVALID_REQUEST");
    const noBen = await read<ApiError>(
      await postPayment(req("/api/payments", { token: login.session.token, body: { beneficiaryId: "ben-missing", amount: 5 } })),
      404,
    );
    expect(noBen.error.code).toBe("NOT_FOUND");
    // Trusted device, known beneficiary: only UNUSUAL_AMOUNT (20, LOW) fires, so the gateway allows it
    // and the funds check refuses it.
    const noFunds = await read<ApiError>(
      await postPayment(req("/api/payments", { token: login.session.token, body: { beneficiaryId: "ben-sara", amount: 100000 } })),
      422,
    );
    expect(noFunds.error.code).toBe("INSUFFICIENT_FUNDS");
    const s = await state();
    expect(s.customer.balance).toBe(92000);
    expect(s.payments.filter((p) => p.status === "REJECTED")).toHaveLength(1);

    const malformed = await postPayment(
      new Request(`${BASE}/api/payments`, {
        method: "POST",
        headers: { authorization: `Bearer ${login.session.token}`, "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(malformed.status).toBe(400);
  });
});
