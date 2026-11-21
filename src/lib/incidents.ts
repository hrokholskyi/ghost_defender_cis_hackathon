import { audit } from "@/lib/audit";
import { now } from "@/lib/clock";
import { getState, nextId, touch } from "@/lib/store";
import type { Actor, CreateIncidentInput, Incident, IncidentStatus } from "@/lib/types";

export function findIncidentForPayment(paymentId: string): Incident | undefined {
  return getState().incidents.find((i) => i.paymentId === paymentId);
}

/** Idempotent per payment: a second call returns the existing incident unchanged. */
export function openIncident(
  actor: Actor,
  sessionId: string,
  paymentId: string,
  input: CreateIncidentInput,
): Incident {
  const existing = findIncidentForPayment(paymentId);
  if (existing) return existing;
  const incident: Incident = {
    id: nextId("INC", 4),
    sessionId,
    paymentId,
    title: input.title,
    severity: input.severity,
    reasons: [...input.reasons],
    status: "OPEN",
    createdAt: now(),
    createdBy: actor,
  };
  getState().incidents.push(incident);
  touch();
  audit({
    actor,
    action: "INCIDENT_CREATED",
    sessionId,
    paymentId,
    detail: `${incident.id} opened (${incident.severity}): ${incident.title}`,
    data: { incidentId: incident.id },
  });
  return incident;
}

export function resolveIncident(
  actor: Actor,
  incident: Incident,
  status: Exclude<IncidentStatus, "OPEN">,
  resolution: string,
): Incident {
  incident.status = status;
  incident.resolvedAt = now();
  incident.resolution = resolution;
  touch();
  audit({
    actor,
    action: status === "CONFIRMED_ATO" ? "INCIDENT_CONFIRMED_ATO" : "INCIDENT_RESOLVED_LEGITIMATE",
    sessionId: incident.sessionId,
    paymentId: incident.paymentId,
    detail: `${incident.id}: ${resolution}`,
    data: { incidentId: incident.id },
  });
  return incident;
}
