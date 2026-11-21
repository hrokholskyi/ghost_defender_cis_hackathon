/** Pure time helpers. All timestamps use the Dubai offset (+04:00), second precision. */
import { TIME_ZONE_OFFSET, TIME_ZONE_OFFSET_MINUTES } from "@/lib/config";
import type { ISODateTime } from "@/lib/types";

export function parseIso(value: ISODateTime): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${value}`);
  return ms;
}

export function isValidIso(value: unknown): value is ISODateTime {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
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
