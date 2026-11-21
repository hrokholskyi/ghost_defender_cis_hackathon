/** Pure time helpers. All timestamps use the Dubai offset (+04:00), second precision. */
import { TIME_ZONE_OFFSET, TIME_ZONE_OFFSET_MINUTES } from "@/lib/config";
import type { ISODateTime } from "@/lib/types";

export function parseIso(value: ISODateTime): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${value}`);
  return ms;
}

/** Simulated time stays in [2000-01-01, 2100-01-01). Outside it, formatting and the demo make no sense. */
export const MIN_SIM_TIME_MS = Date.UTC(2000, 0, 1);
export const MAX_SIM_TIME_MS = Date.UTC(2100, 0, 1);

export function isSimTimeInRange(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_SIM_TIME_MS && ms < MAX_SIM_TIME_MS;
}

/** `YYYY-MM-DDTHH:mm[:ss[.sss]]` with `Z` or a `±HH:mm` offset. */
const STRICT_ISO = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** A strict ISO 8601 date-time inside the simulated time range. */
export function isValidIso(value: unknown): value is ISODateTime {
  return typeof value === "string" && STRICT_ISO.test(value) && isSimTimeInRange(Date.parse(value));
}

/** Formats epoch milliseconds as `YYYY-MM-DDTHH:mm:ss+04:00`. */
export function formatIso(ms: number): ISODateTime {
  const shifted = new Date(Math.floor(ms / 1000) * 1000 + TIME_ZONE_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 19) + TIME_ZONE_OFFSET;
}

/** Normalises any valid ISO timestamp to the Dubai offset. */
export function normalizeIso(value: ISODateTime): ISODateTime {
  return formatIso(parseIso(value));
}

/** Local Dubai wall-clock time, for example "02:03". */
export function clockLabel(value: ISODateTime): string {
  return normalizeIso(value).slice(11, 16);
}

/** Whole minutes from `from` to `to`, rounded. Negative when `to` is earlier. */
export function minutesBetween(from: ISODateTime, to: ISODateTime): number {
  return Math.round((parseIso(to) - parseIso(from)) / 60_000);
}
