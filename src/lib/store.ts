/**
 * The single in-memory store.
 *
 * Kept on globalThis so it survives Next.js dev hot reload and is shared by
 * all route handlers. All data is synthetic.
 */
import { DEFAULT_START_AT } from "@/lib/config";
import type {
  AuditEntry,
  Beneficiary,
  Customer,
  Device,
  Incident,
  Investigation,
  ISODateTime,
  Payment,
  RiskAssessment,
  ScenarioProgress,
  Session,
  SimStatus,
  VerificationRequest,
} from "@/lib/types";

export interface SessionMeta {
  /** Trust of the device at login time. A device trusted later does not change it. */
  deviceTrustedAtLogin: boolean;
}

export interface BankState {
  /** Increases on every mutation. */
  seq: number;
  /** Increases on every reset. Async work started before a reset must not write into the new state. */
  epoch: number;
  /** `capMs` stops now() while a scenario waits for its next scripted step. Null means free running. */
  clock: { simulatedMs: number; realMs: number; capMs: number | null };
  customer: Customer;
  devices: Device[];
  sessions: Session[];
  sessionMeta: Record<string, SessionMeta>;
  beneficiaries: Beneficiary[];
  payments: Payment[];
  risk: Record<string, RiskAssessment>;
  sim: SimStatus;
  investigations: Investigation[];
  incidents: Incident[];
  verifications: VerificationRequest[];
  audit: AuditEntry[];
  scenario: ScenarioProgress | null;
  /** Values that later scenario steps need, for example the beneficiary added by an earlier step. */
  scenarioMemo: Record<string, string>;
  counters: Record<string, number>;
}

const GLOBAL_KEY = "__ghostLoginDefenderStore";

type GlobalWithStore = typeof globalThis & { [GLOBAL_KEY]?: BankState };

export const SEED_CUSTOMER_ID = "cust-001";
export const SEED_TRUSTED_DEVICE_ID = "dev-iphone";
export const SEED_BENEFICIARY_IDS = {
  alNoor: "ben-alnoor",
  dewa: "ben-dewa",
  sara: "ben-sara",
} as const;
export const SEED_BALANCE = 92000;

interface SeedPayment {
  beneficiaryId: string;
  amount: number;
  at: ISODateTime;
}

/** Eight settled payments, median exactly 3000 AED, range 2400-3600. */
const SEED_HISTORY: SeedPayment[] = [
  { beneficiaryId: SEED_BENEFICIARY_IDS.dewa, amount: 2400, at: "2025-10-05T10:12:00+04:00" },
  { beneficiaryId: SEED_BENEFICIARY_IDS.alNoor, amount: 3000, at: "2025-11-01T09:30:00+04:00" },
  { beneficiaryId: SEED_BENEFICIARY_IDS.sara, amount: 2900, at: "2025-11-20T19:45:00+04:00" },
  { beneficiaryId: SEED_BENEFICIARY_IDS.alNoor, amount: 3000, at: "2025-12-01T09:28:00+04:00" },
  { beneficiaryId: SEED_BENEFICIARY_IDS.dewa, amount: 2750, at: "2026-01-06T11:02:00+04:00" },
  { beneficiaryId: SEED_BENEFICIARY_IDS.sara, amount: 3350, at: "2026-01-24T20:15:00+04:00" },
  { beneficiaryId: SEED_BENEFICIARY_IDS.alNoor, amount: 3100, at: "2026-02-01T09:35:00+04:00" },
  { beneficiaryId: SEED_BENEFICIARY_IDS.sara, amount: 3600, at: "2026-02-22T18:50:00+04:00" },
];

function seedState(epoch: number, startAt: ISODateTime): BankState {
  const beneficiaries: Beneficiary[] = [
    {
      id: SEED_BENEFICIARY_IDS.alNoor,
      name: "Al Noor Properties",
      iban: "AE00 DEMO 0000 0000 0000 001",
      createdAt: "2025-09-10T12:00:00+04:00",
      createdBySessionId: null,
      settledPaymentCount: 0,
    },
    {
      id: SEED_BENEFICIARY_IDS.dewa,
      name: "DEWA Utilities",
      iban: "AE00 DEMO 0000 0000 0000 002",
      createdAt: "2025-09-12T08:30:00+04:00",
      createdBySessionId: null,
      settledPaymentCount: 0,
    },
    {
      id: SEED_BENEFICIARY_IDS.sara,
      name: "Sara Hassan",
      iban: "AE00 DEMO 0000 0000 0000 003",
      createdAt: "2025-09-15T19:00:00+04:00",
      createdBySessionId: null,
      settledPaymentCount: 0,
    },
  ];

  const payments: Payment[] = SEED_HISTORY.map((p, i) => {
    const beneficiary = beneficiaries.find((b) => b.id === p.beneficiaryId);
    if (beneficiary) beneficiary.settledPaymentCount += 1;
    return {
      id: `pay-h${String(i + 1).padStart(2, "0")}`,
      sessionId: "historical",
      beneficiaryId: p.beneficiaryId,
      amount: p.amount,
      currency: "AED",
      status: "SETTLED",
      requestedAt: p.at,
      decidedAt: p.at,
      settledAt: p.at,
      riskScore: 0,
      riskLevel: "LOW",
      action: "ALLOW",
      reasons: ["Historical payment (seed data)"],
      historical: true,
    };
  });

  return {
    seq: 0,
    epoch,
    clock: { simulatedMs: Date.parse(startAt), realMs: Date.now(), capMs: null },
    customer: {
      id: SEED_CUSTOMER_ID,
      name: "Layla Hassan",
      maskedPhone: "+971 •• ••• 4821",
      homeCountry: "AE",
      balance: SEED_BALANCE,
      currency: "AED",
    },
    devices: [
      {
        id: SEED_TRUSTED_DEVICE_ID,
        label: "iPhone 15 Pro",
        platform: "iOS",
        trusted: true,
        firstSeenAt: "2025-09-02T18:20:00+04:00",
        lastSeenAt: "2026-03-13T20:40:00+04:00",
      },
    ],
    sessions: [],
    sessionMeta: {},
    beneficiaries,
    payments,
    risk: {},
    sim: { source: "synthetic-telco-signal", swapConfirmed: false, swappedAt: null, reportedAt: null },
    investigations: [],
    incidents: [],
    verifications: [],
    audit: [],
    scenario: null,
    scenarioMemo: {},
    counters: {},
  };
}

export function getState(): BankState {
  const g = globalThis as GlobalWithStore;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = seedState(1, DEFAULT_START_AT);
  return g[GLOBAL_KEY];
}

/** Replaces the store with fresh seed data. The new state has a higher epoch and seq. */
export function resetState(startAt: ISODateTime = DEFAULT_START_AT): BankState {
  const g = globalThis as GlobalWithStore;
  const previous = g[GLOBAL_KEY];
  const next = seedState((previous?.epoch ?? 0) + 1, startAt);
  // seq keeps increasing across resets so pollers always see a change.
  next.seq = (previous?.seq ?? 0) + 1;
  g[GLOBAL_KEY] = next;
  return next;
}

/** Marks a mutation. Call after every change to the state. */
export function touch(): void {
  getState().seq += 1;
}

/** Sequential id such as `sess-001`. */
export function nextId(prefix: string, width = 3): string {
  const state = getState();
  const n = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = n;
  return `${prefix}-${String(n).padStart(width, "0")}`;
}
