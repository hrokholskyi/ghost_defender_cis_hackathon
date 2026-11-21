/**
 * Simulated clock.
 *
 * now() = last set simulated time + real time elapsed since it was set.
 * advanceClock(at) moves the clock forward only, never backward.
 * When clock.capMs is set (a scenario waits for its next step), now() never exceeds it.
 */
import { getState } from "@/lib/store";
import { DomainError } from "@/lib/errors";
import { formatIso, isSimTimeInRange } from "@/lib/time";
import type { ISODateTime } from "@/lib/types";

export function nowMs(): number {
  const { clock } = getState();
  const free = clock.simulatedMs + (Date.now() - clock.realMs);
  return clock.capMs === null ? free : Math.min(free, clock.capMs);
}

export function now(): ISODateTime {
  return formatIso(nowMs());
}

/** Epoch ms of `at`. Throws a 400 for an unparseable or out-of-range value, so the clock never leaves the simulated range. */
function checkedTarget(at: ISODateTime): number {
  const ms = Date.parse(at);
  if (!isSimTimeInRange(ms)) {
    throw new DomainError("INVALID_REQUEST", `Timestamp out of the simulated range (years 2000 to 2099): ${String(at).slice(0, 40)}`);
  }
  return ms;
}

/** Moves the simulated clock forward to `at` when it is later than now. Returns now(). */
export function advanceClock(at?: ISODateTime): ISODateTime {
  if (at !== undefined) {
    const target = checkedTarget(at);
    if (target > nowMs()) {
      const state = getState();
      state.clock = { simulatedMs: target, realMs: Date.now(), capMs: state.clock.capMs };
    }
  }
  return now();
}

/** Sets the clock to an exact time, also backwards. Only for resets and scenario setup. */
export function setClock(at: ISODateTime): void {
  getState().clock = { simulatedMs: checkedTarget(at), realMs: Date.now(), capMs: null };
}

/** Caps now() at `ms`, or removes the cap with null. */
export function setClockCap(ms: number | null): void {
  getState().clock.capMs = ms;
}
