/** Pure display helpers for the dashboard. All times are shown in Dubai time (UTC+4). */

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function money(amount: number): string {
  return `AED ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

interface DubaiParts {
  hh: string;
  mm: string;
  ss: string;
  weekday: string;
  day: number;
  month: string;
}

/** Wall-clock parts in Dubai, independent of the browser time zone. */
export function dubaiParts(iso: string): DubaiParts | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + DUBAI_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    hh: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
    weekday: WEEKDAYS[d.getUTCDay()],
    day: d.getUTCDate(),
    month: MONTHS[d.getUTCMonth()],
  };
}

/** "02:03:04" */
export function hms(iso: string | null | undefined): string {
  const p = iso ? dubaiParts(iso) : null;
  return p ? `${p.hh}:${p.mm}:${p.ss}` : "--:--:--";
}

/** "02:03" */
export function hm(iso: string | null | undefined): string {
  const p = iso ? dubaiParts(iso) : null;
  return p ? `${p.hh}:${p.mm}` : "--:--";
}

/** Lock screen style: "2:03" (no leading zero on the hour). */
export function lockTime(iso: string): string {
  const p = dubaiParts(iso);
  return p ? `${Number(p.hh)}:${p.mm}` : "";
}

/** "Sunday 15 March" */
export function dateLabel(iso: string): string {
  const p = dubaiParts(iso);
  return p ? `${p.weekday} ${p.day} ${p.month}` : "";
}

/** Whole minutes from `from` to `to`, rounded. */
export function minutesBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
}

/** "1:05" for 65 seconds. Never negative. */
export function elapsed(from: string, to: string): string {
  const total = Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export type TextPart = { text: string } | { href: string };

/** Splits text into plain parts and http(s) links. Trailing punctuation stays outside the link. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    let url = match[0];
    const trail = /[.,;:!?)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
