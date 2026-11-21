import type {
  InvestigationContext,
  InvestigationSink,
  InvestigationStep,
  InvestigationTools,
  RiskAction,
  RiskLevel,
  ToolName,
} from "@/lib/types";

export function atoContext(action: RiskAction = "HOLD_AND_RESTRICT", level: RiskLevel = "CRITICAL", score = 90): InvestigationContext {
  const at = "2026-03-01T02:03:00.000Z";
  return {
    investigationId: "inv-1",
    sessionId: "sess-attacker",
    paymentId: "pay-1",
    appliedAction: action,
    payment: { amount: 85000, currency: "AED", beneficiaryName: "Quick Trading LLC" },
    risk: {
      sessionId: "sess-attacker",
      score,
      level,
      action,
      assessedAt: at,
      signals: [
        { id: "UNKNOWN_DEVICE", label: "Unknown device", points: 25, evidence: "Galaxy A54 not in device history", cumulative: 25, detectedAt: at },
        { id: "RECENT_SIM_SWAP", label: "Recent SIM swap", points: 30, evidence: "SIM swapped 45 min before login", cumulative: 55, detectedAt: at },
        { id: "NEW_BENEFICIARY", label: "New beneficiary", points: 15, evidence: "Added in this session", cumulative: 70, detectedAt: at },
        { id: "UNUSUAL_AMOUNT", label: "Unusual amount", points: 20, evidence: "Transfer is 28.3x the typical AED 3,000", cumulative: 90, detectedAt: at },
      ],
    },
  };
}

export type FakeTools = InvestigationTools & { calls: ToolName[] };

/** Tools shaped like the account-takeover case. `overrides` replace single tools. */
export function fakeTools(overrides: Partial<InvestigationTools> = {}): FakeTools {
  const calls: ToolName[] = [];
  const base: InvestigationTools = {
    async get_device_history() {
      return {
        currentDevice: { id: "dev-new", label: "Galaxy A54", platform: "Android", known: false, firstSeenAt: "2026-03-01T02:00:00.000Z" },
        knownDevices: [{ id: "dev-iphone", label: "iPhone 15", platform: "iOS", lastSeenAt: "2026-02-28T20:00:00.000Z" }],
      };
    },
    async get_sim_status() {
      return { available: true, source: "synthetic-telco-signal", swapConfirmed: true, swappedAt: "2026-03-01T01:15:00.000Z", minutesBeforeLogin: 45 };
    },
    async get_session_activity() {
      return {
        sessionId: "sess-attacker",
        loginAt: "2026-03-01T02:00:00.000Z",
        network: { ip: "203.0.113.7", city: "Lagos", country: "NG" },
        events: [],
        minutesFromLoginToTransfer: 3,
      };
    },
    async get_payment_history() {
      return { settledCount: 12, typicalAmount: 3000, maxAmount: 7500, currency: "AED", recent: [], currentAmount: 85000, ratioToTypical: 28.3 };
    },
    async check_beneficiary() {
      return {
        beneficiaryId: "ben-new",
        name: "Quick Trading LLC",
        ibanMasked: "AE07 **** 1234",
        knownBefore: false,
        priorSettledPayments: 0,
        addedAt: "2026-03-01T02:01:00.000Z",
        addedInThisSession: true,
      };
    },
    async create_incident(input) {
      return {
        id: "INC-0001",
        sessionId: "sess-attacker",
        paymentId: "pay-1",
        title: input.title,
        severity: input.severity,
        reasons: input.reasons,
        status: "OPEN",
        createdAt: "2026-03-01T02:04:00.000Z",
        createdBy: "ai-investigator",
      };
    },
  };
  const merged = { ...base, ...overrides };
  const tools = { calls } as FakeTools;
  for (const name of Object.keys(merged) as ToolName[]) {
    const fn = merged[name] as (...args: unknown[]) => Promise<unknown>;
    (tools as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls.push(name);
      return fn(...args);
    };
  }
  return tools;
}

export interface RecordingSink extends InvestigationSink {
  engines: Array<{ engine: string; model?: string; fallbackReason?: string }>;
  /** Every stepStarted / stepFinished call in order. */
  events: Array<{ type: "started" | "finished"; step: InvestigationStep }>;
  /** Final state of each step, in start order. */
  steps(): InvestigationStep[];
}

export function recordingSink(): RecordingSink {
  const engines: RecordingSink["engines"] = [];
  const events: RecordingSink["events"] = [];
  return {
    engines,
    events,
    engineSelected: (info) => void engines.push(info),
    stepStarted: (step) => void events.push({ type: "started", step }),
    stepFinished: (step) => void events.push({ type: "finished", step }),
    now: () => "2026-03-01T02:04:00.000Z",
    steps() {
      const byId = new Map<string, InvestigationStep>();
      for (const e of events) byId.set(e.step.id, e.step);
      return [...byId.values()];
    },
  };
}

export function toolSteps(sink: RecordingSink) {
  return sink.steps().filter((s): s is Extract<InvestigationStep, { kind: "tool_call" }> => s.kind === "tool_call");
}
