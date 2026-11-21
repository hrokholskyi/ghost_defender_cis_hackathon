import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { now, nowMs } from "@/lib/clock";
import { whenIdle } from "@/lib/investigations";
import { at } from "@/lib/scenario-catalog";
import { nextScenarioStep, resetSimulator, startScenario } from "@/lib/scenarios";
import { getSnapshot } from "@/lib/snapshot";
import { minutesBetween, parseIso } from "@/lib/time";
import { attackerSession, freshStore } from "./helpers";

const MINUTE = 60_000;

beforeEach(async () => {
  // Only Date is faked, so investigation timers still run (tests use GLD_STEP_DELAY_MS=0).
  vi.useFakeTimers({ toFake: ["Date"] });
  await freshStore();
});

afterEach(async () => {
  await whenIdle();
  vi.useRealTimers();
});

function wait(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe("scenario clock", () => {
  it("keeps scripted step times however long the presenter waits", async () => {
    startScenario("B");
    nextScenarioStep();
    for (let i = 0; i < 3; i++) {
      wait(5 * MINUTE);
      nextScenarioStep();
    }
    await whenIdle();
    const state = getSnapshot();

    const scripted: Array<[string, string]> = [
      ["LOGIN_SUCCEEDED", "02:00"],
      ["SIM_SWAP_REPORTED", "02:01"],
      ["BENEFICIARY_ADDED", "02:02"],
      ["PAYMENT_REQUESTED", "02:03"],
    ];
    const times = scripted.map(([kind]) => state.audit.findLast((e) => e.action === kind)?.at);
    expect(times).toEqual(scripted.map(([, clock]) => at(clock)));

    const session = attackerSession(state);
    const payment = state.payments.find((p) => !p.historical)!;
    expect(minutesBetween(session.createdAt, payment.requestedAt)).toBe(3);
  });

  it("stops one second before the next scripted time between steps", () => {
    startScenario("B");
    expect(now()).toBe(at("01:59"));
    wait(10 * MINUTE);
    expect(now()).toBe("2026-03-15T01:59:59+04:00");
    nextScenarioStep();
    expect(now()).toBe(at("02:00"));
    wait(30_000);
    expect(now()).toBe("2026-03-15T02:00:30+04:00");
    wait(10 * MINUTE);
    expect(now()).toBe("2026-03-15T02:00:59+04:00");
    nextScenarioStep();
    expect(now()).toBe(at("02:01"));
  });

  it("runs freely after the last step", () => {
    startScenario("B");
    for (let i = 0; i < 4; i++) nextScenarioStep();
    const before = nowMs();
    wait(30_000);
    expect(nowMs()).toBe(before + 30_000);
    wait(10 * MINUTE);
    expect(nowMs()).toBe(before + 30_000 + 10 * MINUTE);
    expect(parseIso(now())).toBeGreaterThan(parseIso(at("02:03")));
  });

  it("has no cap after resetSimulator", () => {
    startScenario("B");
    resetSimulator();
    const before = nowMs();
    wait(10 * MINUTE);
    expect(nowMs()).toBe(before + 10 * MINUTE);
  });
});
