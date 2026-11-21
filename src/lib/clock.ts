/**
 * Simulated clock.
 *
 * now() = last set simulated time + real time elapsed since it was set.
 * advanceClock(at) moves the clock forward only, never backward.
 */
import { getState } from "@/lib/store";
import { formatIso, parseIso } from "@/lib/time";
import type { ISODateTime } from "@/lib/types";

export function nowMs(): number {
  const { clock } = getState();
  return clock.simulatedMs + (Date.now() - clock.realMs);
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
      state.clock = { simulatedMs: target, realMs: Date.now() };
    }
  }
  return now();
}

/** Sets the clock to an exact time, also backwards. Only for resets and scenario setup. */
export function setClock(at: ISODateTime): void {
  getState().clock = { simulatedMs: parseIso(at), realMs: Date.now() };
}
