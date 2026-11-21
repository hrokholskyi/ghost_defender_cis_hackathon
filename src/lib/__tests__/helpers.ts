import { whenIdle } from "@/lib/investigations";
import { nextScenarioStep, startScenario } from "@/lib/scenarios";
import { getSnapshot } from "@/lib/snapshot";
import { resetState } from "@/lib/store";
import type { ScenarioId, Session, StateSnapshot } from "@/lib/types";

/** Waits for leftover investigations, then restores seed data. */
export async function freshStore(): Promise<void> {
  await whenIdle();
  resetState();
}

export function runScenario(id: ScenarioId): StateSnapshot {
  startScenario(id);
  let state = getSnapshot();
  while (state.scenario && state.scenario.nextStep < state.scenario.totalSteps) {
    state = nextScenarioStep().state;
  }
  return state;
}

export function sessionById(state: StateSnapshot, id: string | null | undefined): Session {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) throw new Error(`Session ${id} not in snapshot`);
  return session;
}

/** Scenario B: the attacker's session (created by the LOGIN step). */
export function attackerSession(state: StateSnapshot): Session {
  return sessionById(state, state.scenario?.actorSessionId);
}

/** Scenario B: Layla's own iPhone session from the previous evening. */
export function iphoneSession(state: StateSnapshot): Session {
  const session = state.sessions.find((s) => s.deviceId === "dev-iphone");
  if (!session) throw new Error("No iPhone session");
  return session;
}

export function auditActions(state: StateSnapshot): string[] {
  return state.audit.map((e) => e.action);
}
