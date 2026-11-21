/**
 * Simulated clock.
 *
 * now() = last set simulated time + real time elapsed since it was set.
 * advanceClock(at) moves the clock forward only, never backward.
 * When clock.capMs is set (a scenario waits for its next step), now() never exceeds it.
 */
import { getState } from "@/lib/store";
import { formatIso, parseIso } from "@/lib/time";
import type { ISODateTime } from "@/lib/types";

export function nowMs(): number {
  const { clock } = getState();
  const free = clock.simulatedMs + (Date.now() - clock.realMs);
  return clock.capMs === null ? free : Math.min(free, clock.capMs);
}

export function now(): ISODateTime {
  return formatIso(nowMs());
}

/** Moves the simulated clock forward to `at` when it is later than now. Returns now(). */
export function advanceClock(at?: ISODateTime): ISODateTime {
  if (at !== undefined) {
    const target = parseIso(at);
    if (target > nowMs()) {
      const state = getState();
      state.clock = { simulatedMs: target, realMs: Date.now(), capMs: state.clock.capMs };
    }
  }
  return now();
}

/** Sets the clock to an exact time, also backwards. Only for resets and scenario setup. */
export function setClock(at: ISODateTime): void {
  getState().clock = { simulatedMs: parseIso(at), realMs: Date.now(), capMs: null };
}

/** Caps now() at `ms`, or removes the cap with null. */
export function setClockCap(ms: number | null): void {
  getState().clock.capMs = ms;
}
