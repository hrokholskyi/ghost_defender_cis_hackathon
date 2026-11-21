/**
 * Demo scenarios. Every step runs through the same domain functions as the
 * public routes. All timestamps use one fixed synthetic date.
 */
import { addBeneficiary, login, reportSimSwap } from "@/lib/bank";
import { requestTransfer } from "@/lib/payment-gateway";
import { SEED_BENEFICIARY_IDS, SEED_TRUSTED_DEVICE_ID } from "@/lib/store";
import type { ISODateTime, NetworkContext, ScenarioId, ScenarioInfo, ScenarioStepInfo } from "@/lib/types";

export const SCENARIO_DATE = "2026-03-15";
export const SCENARIO_PREVIOUS_DATE = "2026-03-14";

/** Dubai wall-clock time on the scenario date, for example at("02:03"). */
export function at(clock: string, date: string = SCENARIO_DATE): ISODateTime {
  return `${date}T${clock}:00+04:00`;
}

export const DUBAI_HOME_NETWORK: NetworkContext = { ip: "10.20.30.41", city: "Dubai", country: "AE" };
export const DUBAI_MOBILE_NETWORK: NetworkContext = { ip: "10.88.14.207", city: "Dubai", country: "AE" };

/** Memo keys shared between steps of one scenario run. */
export const MEMO = {
  actorToken: "actorToken",
  customerToken: "customerToken",
  beneficiaryId: "beneficiaryId",
} as const;

export interface ScenarioStep {
  info: ScenarioStepInfo;
  /** Runs the step. Returns the session id created by a LOGIN step. */
  run(memo: Record<string, string>): string | void;
}

export interface ScenarioDefinition {
  info: ScenarioInfo;
  /** Clock at reset, before preconditions run. */
  resetAt: ISODateTime;
  /** Preconditions on top of the seed data. */
  setup?(memo: Record<string, string>): void;
  /** Clock after the preconditions, just before the first step. */
  readyAt: ISODateTime;
  steps: ScenarioStep[];
}

function token(memo: Record<string, string>, key: string): string {
  const value = memo[key];
  if (!value) throw new Error(`Scenario memo is missing ${key}`);
  return value;
}

function loginStep(
  info: ScenarioStepInfo,
  request: Parameters<typeof login>[0],
): ScenarioStep {
  return {
    info,
    run(memo) {
      const { session } = login(request);
      memo[MEMO.actorToken] = session.token;
      return session.id;
    },
  };
}

const SCENARIO_A: ScenarioDefinition = {
  info: {
    id: "A",
    title: "Normal customer",
    description: "Layla logs in from her own iPhone at home in Dubai and pays her usual rent instalment.",
    expected: "Risk 0 (LOW). The payment settles at once. Balance AED 89,000.",
    steps: [
      { type: "LOGIN", label: "Login from trusted iPhone 15 Pro", clock: "19:30", persona: "customer" },
      { type: "TRANSFER", label: "AED 3,000 to Al Noor Properties", clock: "19:32", persona: "customer" },
    ],
  },
  resetAt: at("19:29"),
  readyAt: at("19:29"),
  steps: [],
};
SCENARIO_A.steps = [
  loginStep(SCENARIO_A.info.steps[0], {
    deviceId: SEED_TRUSTED_DEVICE_ID,
    network: DUBAI_HOME_NETWORK,
    at: at("19:30"),
  }),
  {
    info: SCENARIO_A.info.steps[1],
    run(memo) {
      requestTransfer(token(memo, MEMO.actorToken), {
        beneficiaryId: SEED_BENEFICIARY_IDS.alNoor,
        amount: 3000,
        at: at("19:32"),
      });
    },
  },
];

const SCENARIO_B: ScenarioDefinition = {
  info: {
    id: "B",
    title: "Account takeover (ghost login)",
    description:
      "A fraudster has Layla's password from phishing and intercepts the SMS code after a SIM swap. Login succeeds. Layla's own iPhone is still signed in since last evening.",
    expected:
      "Risk climbs 15 -> 40 -> 55 -> 90 (CRITICAL). The AED 85,000 transfer is HELD before debit, the attacker session is RESTRICTED, a push goes to the trusted iPhone, and the AI investigation opens an incident. Balance stays AED 92,000.",
    steps: [
      { type: "LOGIN", label: "Login from new Samsung Galaxy A54", clock: "02:00", persona: "attacker" },
      { type: "SIM_SWAP", label: "Telco reports SIM swap at 01:15", clock: "02:01", persona: "attacker" },
      { type: "ADD_BENEFICIARY", label: "Adds beneficiary Orion Trading FZE", clock: "02:02", persona: "attacker" },
      { type: "TRANSFER", label: "AED 85,000 to Orion Trading FZE", clock: "02:03", persona: "attacker" },
    ],
  },
  resetAt: at("21:14", SCENARIO_PREVIOUS_DATE),
  setup(memo) {
    const { session } = login({
      deviceId: SEED_TRUSTED_DEVICE_ID,
      network: DUBAI_HOME_NETWORK,
      at: at("21:15", SCENARIO_PREVIOUS_DATE),
    });
    memo[MEMO.customerToken] = session.token;
  },
  readyAt: at("01:59"),
  steps: [],
};
SCENARIO_B.steps = [
  loginStep(SCENARIO_B.info.steps[0], {
    deviceId: "dev-android-x",
    device: { label: "Samsung Galaxy A54", platform: "Android" },
    network: DUBAI_MOBILE_NETWORK,
    at: at("02:00"),
  }),
  {
    info: SCENARIO_B.info.steps[1],
    run() {
      reportSimSwap({ swappedAt: at("01:15"), at: at("02:01") });
    },
  },
  {
    info: SCENARIO_B.info.steps[2],
    run(memo) {
      const { beneficiary } = addBeneficiary(token(memo, MEMO.actorToken), {
        name: "Orion Trading FZE",
        iban: "AE00 DEMO 9999 0000 0000 777",
        at: at("02:02"),
      });
      memo[MEMO.beneficiaryId] = beneficiary.id;
    },
  },
  {
    info: SCENARIO_B.info.steps[3],
    run(memo) {
      requestTransfer(token(memo, MEMO.actorToken), {
        beneficiaryId: token(memo, MEMO.beneficiaryId),
        amount: 85000,
        at: at("02:03"),
      });
    },
  },
];

const SCENARIO_C: ScenarioDefinition = {
  info: {
    id: "C",
    title: "Legitimate phone change",
    description: "Layla bought a new iPhone 16 and logs in from home. No SIM swap. She pays her sister as usual.",
    expected: "Risk 15 (LOW) for the new device only. The payment settles and the session stays ACTIVE. No incident.",
    steps: [
      { type: "LOGIN", label: "Login from new iPhone 16", clock: "10:00", persona: "customer" },
      { type: "TRANSFER", label: "AED 3,200 to Sara Hassan", clock: "10:05", persona: "customer" },
    ],
  },
  resetAt: at("09:59"),
  readyAt: at("09:59"),
  steps: [],
};
SCENARIO_C.steps = [
  loginStep(SCENARIO_C.info.steps[0], {
    deviceId: "dev-iphone-16",
    device: { label: "iPhone 16", platform: "iOS" },
    network: DUBAI_HOME_NETWORK,
    at: at("10:00"),
  }),
  {
    info: SCENARIO_C.info.steps[1],
    run(memo) {
      requestTransfer(token(memo, MEMO.actorToken), {
        beneficiaryId: SEED_BENEFICIARY_IDS.sara,
        amount: 3200,
        at: at("10:05"),
      });
    },
  },
];

export const SCENARIOS: Record<ScenarioId, ScenarioDefinition> = { A: SCENARIO_A, B: SCENARIO_B, C: SCENARIO_C };

export const SCENARIO_INFOS: ScenarioInfo[] = [SCENARIO_A.info, SCENARIO_B.info, SCENARIO_C.info];
