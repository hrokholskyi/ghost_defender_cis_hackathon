/** Demo driver: reset, scenario start and step-by-step execution. */
import { audit } from "@/lib/audit";
import { advanceClock, setClockCap } from "@/lib/clock";
import { DomainError } from "@/lib/errors";
import { SCENARIOS, at } from "@/lib/scenario-catalog";
import { getSnapshot } from "@/lib/snapshot";
import { getState, resetState, touch } from "@/lib/store";
import { parseIso } from "@/lib/time";
import type { ScenarioId, ScenarioNextResponse, StateSnapshot } from "@/lib/types";

export { SCENARIO_INFOS, SCENARIOS } from "@/lib/scenario-catalog";

/** Caps the clock one second before the next scripted step, or frees it when none is left. */
function capBeforeStep(id: ScenarioId, stepIndex: number): void {
  const step = SCENARIOS[id].steps[stepIndex];
  setClockCap(step ? parseIso(at(step.info.clock)) - 1000 : null);
}

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
  capBeforeStep(id, 0);
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
  // The cap holds the clock just before this step. Jump to the scripted time, then let it run.
  advanceClock(at(step.info.clock));
  setClockCap(null);
  const sessionId = step.run(state.scenarioMemo);
  if (typeof sessionId === "string") progress.actorSessionId = sessionId;
  progress.nextStep += 1;
  capBeforeStep(progress.id, progress.nextStep);
  touch();
  return { step: step.info, scenario: { ...progress }, state: getSnapshot() };
}
