import { RISK_CONFIG } from "@/lib/config";
import { now } from "@/lib/clock";
import { getLlmStatus } from "@/lib/investigator";
import { SCENARIO_INFOS } from "@/lib/scenario-catalog";
import { getState } from "@/lib/store";
import type { StateSnapshot } from "@/lib/types";

/** A deep copy of the public state for GET /api/state. */
export function getSnapshot(): StateSnapshot {
  const s = getState();
  return structuredClone({
    seq: s.seq,
    now: now(),
    customer: s.customer,
    devices: s.devices,
    sessions: s.sessions,
    beneficiaries: s.beneficiaries,
    payments: s.payments,
    risk: s.risk,
    sim: s.sim,
    investigations: s.investigations,
    incidents: s.incidents,
    verifications: s.verifications,
    audit: s.audit,
    scenarios: SCENARIO_INFOS,
    scenario: s.scenario,
    riskConfig: RISK_CONFIG,
    llm: getLlmStatus(),
  });
}
