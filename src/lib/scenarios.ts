/** Demo driver: reset, scenario start and step-by-step execution. */
import { audit } from "@/lib/audit";
import { advanceClock } from "@/lib/clock";
import { DomainError } from "@/lib/errors";
import { SCENARIOS } from "@/lib/scenario-catalog";
import { getSnapshot } from "@/lib/snapshot";
import { getState, resetState, touch } from "@/lib/store";
import type { ScenarioId, ScenarioNextResponse, StateSnapshot } from "@/lib/types";

export { SCENARIO_INFOS, SCENARIOS } from "@/lib/scenario-catalog";

/** Fresh seed data, no scenario. */
export function resetSimulator(): StateSnapshot {
  resetState();
  audit({ actor: "bank-simulator", action: "SIMULATOR_RESET", detail: "Simulator reset to seed data" });
  return getSnapshot();
}

/** Reset plus the scenario's preconditions. */
export function startScenario(id: ScenarioId): StateSnapshot {
  const definition = SCENARIOS[id];
  resetState(definition.resetAt);
  const state = getState();
  audit({
    actor: "bank-simulator",
    action: "SCENARIO_STARTED",
    detail: `Scenario ${id}: ${definition.info.title}`,
    data: { scenarioId: id },
  });
  definition.setup?.(state.scenarioMemo);
  advanceClock(definition.readyAt);
  state.scenario = { id, nextStep: 0, totalSteps: definition.steps.length, actorSessionId: null };
  touch();
  return getSnapshot();
}

/** Runs the next step of the active scenario. 409 when none is active or it already finished. */
export function nextScenarioStep(): ScenarioNextResponse {
  const state = getState();
  const progress = state.scenario;
  if (!progress) throw new DomainError("CONFLICT", "No scenario is active. Start one first");
  if (progress.nextStep >= progress.totalSteps) {
    throw new DomainError("CONFLICT", `Scenario ${progress.id} already finished`);
  }
  const step = SCENARIOS[progress.id].steps[progress.nextStep];
  const sessionId = step.run(state.scenarioMemo);
  if (typeof sessionId === "string") progress.actorSessionId = sessionId;
  progress.nextStep += 1;
  touch();
  return { step: step.info, scenario: { ...progress }, state: getSnapshot() };
}
