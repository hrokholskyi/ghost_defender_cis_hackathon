/**
 * Decides whether the dashboard takes a polled snapshot. Pure, no DOM.
 *
 * Within one server process `seq` only grows, so an older snapshot is a late
 * response and is dropped. A snapshot from another server process (the server
 * restarted and `seq` began again) is always taken.
 */
import type { StateSnapshot } from "@/lib/types";

export function acceptSnapshot(prev: StateSnapshot | null, next: unknown): next is StateSnapshot {
  if (!next || typeof next !== "object") return false;
  const { seq, serverId } = next as Partial<StateSnapshot>;
  if (typeof seq !== "number" || !Number.isFinite(seq) || typeof serverId !== "string" || !serverId) return false;
  if (!prev || prev.serverId !== serverId) return true;
  return seq >= prev.seq;
}
