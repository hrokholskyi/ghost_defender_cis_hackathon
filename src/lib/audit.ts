import { now } from "@/lib/clock";
import { getState, touch } from "@/lib/store";
import type { Actor, AuditEntry } from "@/lib/types";

export interface AuditInput {
  actor: Actor;
  /** SCREAMING_SNAKE_CASE. */
  action: string;
  detail: string;
  sessionId?: string;
  paymentId?: string;
  data?: Record<string, unknown>;
}

/** Appends an entry to the audit log. Every event, decision and protective action goes here. */
export function audit(input: AuditInput): AuditEntry {
  const state = getState();
  touch();
  const entry: AuditEntry = {
    seq: state.seq,
    at: now(),
    actor: input.actor,
    action: input.action,
    detail: input.detail,
  };
  if (input.sessionId) entry.sessionId = input.sessionId;
  if (input.paymentId) entry.paymentId = input.paymentId;
  if (input.data) entry.data = input.data;
  state.audit.push(entry);
  return entry;
}
