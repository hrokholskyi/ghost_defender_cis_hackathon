/**
 * Ghost Login Defender - shared contract.
 *
 * Every module (bank simulator, risk engine, gateways, AI investigator, API
 * routes, dashboard) talks through these shapes. Change them only additively
 * and report every change, because several modules are built in parallel
 * against this file.
 *
 * All data is synthetic. Risk weights and thresholds are demo values, not a
 * calibrated model.
 */

export type ISODateTime = string;
export type Currency = "AED";

// ---------------------------------------------------------------------------
// Bank simulator
// ---------------------------------------------------------------------------

export interface Customer {
  id: string;
  name: string;
  maskedPhone: string;
  /** ISO 3166-1 alpha-2 country the customer normally logs in from. */
  homeCountry: string;
  balance: number;
  currency: Currency;
}

export interface Device {
  id: string;
  label: string;
  platform: "iOS" | "Android";
  /** True when the device is in the customer's known device history. */
  trusted: boolean;
  firstSeenAt: ISODateTime | null;
  lastSeenAt: ISODateTime | null;
}

export interface NetworkContext {
  ip: string;
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

export type SessionStatus = "ACTIVE" | "RESTRICTED" | "REVOKED";

export interface Session {
  id: string;
  /**
   * Bearer token for this session. Exposed in the state snapshot ONLY because
   * this is a simulator and the dashboard must act as both personas.
   */
  token: string;
  deviceId: string;
  network: NetworkContext;
  createdAt: ISODateTime;
  status: SessionStatus;
  restrictedAt?: ISODateTime;
  restrictionReason?: string;
}

export interface Beneficiary {
  id: string;
  name: string;
  iban: string;
  createdAt: ISODateTime;
  /** Null for beneficiaries that exist in the seed data. */
  createdBySessionId: string | null;
  /** Number of SETTLED payments to this beneficiary. */
  settledPaymentCount: number;
}

/**
 * SETTLED               money left the account.
 * HELD                  blocked before debit; balance untouched.
 * PENDING_VERIFICATION  step-up: waits for confirmation on a trusted channel; balance untouched.
 * CANCELLED             a held or pending payment that was denied by the real customer.
 * REJECTED              refused outright (restricted or revoked session, insufficient funds).
 */
export type PaymentStatus =
  | "SETTLED"
  | "HELD"
  | "PENDING_VERIFICATION"
  | "CANCELLED"
  | "REJECTED";

export interface Payment {
  id: string;
  sessionId: string;
  beneficiaryId: string;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  requestedAt: ISODateTime;
  decidedAt: ISODateTime;
  settledAt?: ISODateTime;
  /** Session risk at decision time. Zero for seed history. */
  riskScore: number;
  riskLevel: RiskLevel;
  action: RiskAction;
  /** Human-readable reasons for the gateway decision. */
  reasons: string[];
  /** True for seed history payments. */
  historical: boolean;
}

/** Synthetic telco signal. In a real bank this needs an authorised data source. */
export interface SimStatus {
  source: "synthetic-telco-signal";
  swapConfirmed: boolean;
  swappedAt: ISODateTime | null;
  /** When the bank received the signal. */
  reportedAt: ISODateTime | null;
}

// ---------------------------------------------------------------------------
// Risk engine (deterministic, transparent point model)
// ---------------------------------------------------------------------------

export type RiskSignalId =
  | "UNKNOWN_DEVICE"
  | "RECENT_SIM_SWAP"
  | "UNUSUAL_NETWORK"
  | "NEW_BENEFICIARY"
  | "UNUSUAL_AMOUNT"
  | "RAPID_SEQUENCE";

/** Canonical evaluation and display order of signals. */
export const RISK_SIGNAL_ORDER: readonly RiskSignalId[] = [
  "UNKNOWN_DEVICE",
  "RECENT_SIM_SWAP",
  "UNUSUAL_NETWORK",
  "NEW_BENEFICIARY",
  "UNUSUAL_AMOUNT",
  "RAPID_SEQUENCE",
] as const;

export interface RiskSignal {
  id: RiskSignalId;
  label: string;
  points: number;
  /** Fact that triggered the signal, for example "Transfer is 28.3x the typical AED 3,000". */
  evidence: string;
  /** Running score after this signal, following RISK_SIGNAL_ORDER. */
  cumulative: number;
  /** Simulated time at which the signal first fired for the session. */
  detectedAt: ISODateTime;
}

/** 0-29 LOW, 30-59 ELEVATED, 60-79 HIGH, 80-100 CRITICAL. */
export type RiskLevel = "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";

/**
 * ALLOW              continue and monitor.
 * STEP_UP            extra verification before a sensitive action.
 * HOLD               hold the risky payment until independent verification.
 * HOLD_AND_RESTRICT  hold the payment, restrict the suspicious session, open an incident.
 */
export type RiskAction = "ALLOW" | "STEP_UP" | "HOLD" | "HOLD_AND_RESTRICT";

export interface RiskAssessment {
  sessionId: string;
  /** 0-100. */
  score: number;
  level: RiskLevel;
  action: RiskAction;
  /** Fired signals only, in RISK_SIGNAL_ORDER. Signals are sticky for the session lifetime. */
  signals: RiskSignal[];
  assessedAt: ISODateTime;
}

export interface RiskConfig {
  weights: Record<RiskSignalId, number>;
  /** Lower bound of each level. */
  thresholds: { elevated: number; high: number; critical: number };
  /** Must be shown in the UI next to scores. */
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// AI investigation
// ---------------------------------------------------------------------------

export type ToolName =
  | "get_device_history"
  | "get_sim_status"
  | "get_session_activity"
  | "get_payment_history"
  | "check_beneficiary"
  | "create_incident";

export interface DeviceHistoryResult {
  currentDevice: {
    id: string;
    label: string;
    platform: Device["platform"];
    known: boolean;
    firstSeenAt: ISODateTime | null;
  };
  knownDevices: Array<{
    id: string;
    label: string;
    platform: Device["platform"];
    lastSeenAt: ISODateTime | null;
  }>;
}

export interface SimStatusResult {
  /** False when no authorised signal source is reachable. Then the swap state is unknown. */
  available: boolean;
  source: SimStatus["source"];
  swapConfirmed: boolean;
  swappedAt: ISODateTime | null;
  /** Minutes between the SIM swap and the login of the investigated session. */
  minutesBeforeLogin: number | null;
}

export interface SessionActivityResult {
  sessionId: string;
  loginAt: ISODateTime;
  network: NetworkContext;
  events: Array<{ at: ISODateTime; type: string; detail: string }>;
  minutesFromLoginToTransfer: number | null;
}

export interface PaymentHistoryResult {
  settledCount: number;
  /** Median of settled history amounts. */
  typicalAmount: number;
  maxAmount: number;
  currency: Currency;
  recent: Array<{ amount: number; beneficiaryName: string; settledAt: ISODateTime }>;
  currentAmount: number;
  /** currentAmount / typicalAmount, rounded to one decimal. */
  ratioToTypical: number;
}

export interface BeneficiaryCheckResult {
  beneficiaryId: string;
  name: string;
  ibanMasked: string;
  /** True when at least one payment to this beneficiary settled before. */
  knownBefore: boolean;
  priorSettledPayments: number;
  addedAt: ISODateTime;
  addedInThisSession: boolean;
}

export interface CreateIncidentInput {
  title: string;
  severity: RiskLevel;
  reasons: string[];
}

export type IncidentStatus = "OPEN" | "CONFIRMED_ATO" | "RESOLVED_LEGITIMATE";

export interface Incident {
  /** For example "INC-0001". */
  id: string;
  sessionId: string;
  paymentId: string;
  title: string;
  severity: RiskLevel;
  reasons: string[];
  status: IncidentStatus;
  createdAt: ISODateTime;
  createdBy: Actor;
  resolvedAt?: ISODateTime;
  resolution?: string;
}

/**
 * Tools handed to the investigator. They are already bound to one session and
 * one payment, so the model cannot query other customers or sessions.
 * Read tools take no input. `create_incident` is idempotent per payment: a
 * second call returns the existing incident.
 */
export interface InvestigationTools {
  get_device_history(): Promise<DeviceHistoryResult>;
  get_sim_status(): Promise<SimStatusResult>;
  get_session_activity(): Promise<SessionActivityResult>;
  get_payment_history(): Promise<PaymentHistoryResult>;
  check_beneficiary(): Promise<BeneficiaryCheckResult>;
  create_incident(input: CreateIncidentInput): Promise<Incident>;
}

export type InvestigationEngine = "devin" | "deterministic-fallback";

export type InvestigationStep =
  | {
      kind: "tool_call";
      id: string;
      tool: ToolName;
      input: Record<string, unknown>;
      /** Undefined while running. */
      output?: unknown;
      status: "running" | "ok" | "error";
      error?: string;
      startedAt: ISODateTime;
      finishedAt?: ISODateTime;
    }
  | {
      /** Short narration from the investigator between tool calls. */
      kind: "note";
      id: string;
      text: string;
      startedAt: ISODateTime;
    };

export interface InvestigationVerdict {
  assessment: "LIKELY_ACCOUNT_TAKEOVER" | "SUSPICIOUS" | "LIKELY_LEGITIMATE";
  /** Two to four sentences. Must rely only on tool results. */
  summary: string;
  /** One bullet per fact, each traceable to a tool result. */
  evidence: string[];
  /**
   * Recommendation only. The policy gateway decides. It can tighten protection
   * (hold, restrict) and can never release a hold or lift a restriction.
   */
  recommendedAction: RiskAction;
  incidentId?: string;
}

export interface Investigation {
  id: string;
  sessionId: string;
  paymentId: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  engine: InvestigationEngine;
  model?: string;
  /** Why the deterministic fallback was used. Shown in the UI. */
  fallbackReason?: string;
  steps: InvestigationStep[];
  verdict?: InvestigationVerdict;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime;
}

export interface InvestigationContext {
  investigationId: string;
  sessionId: string;
  paymentId: string;
  /** Risk assessment that the gateway used for its decision. */
  risk: RiskAssessment;
  /** What the gateway already did, by code, before the investigation started. */
  appliedAction: RiskAction;
  payment: { amount: number; currency: Currency; beneficiaryName: string };
}

/** The investigator reports progress through this sink. The bank core stores it for the UI. */
export interface InvestigationSink {
  /** Called once at start, and again if the engine switches to the fallback mid-run. */
  engineSelected(info: {
    engine: InvestigationEngine;
    model?: string;
    fallbackReason?: string;
  }): void;
  /** Append a step. Tool calls start with status "running". */
  stepStarted(step: InvestigationStep): void;
  /** Replace the step with the same id. */
  stepFinished(step: InvestigationStep): void;
  /** Simulated clock, for step timestamps. */
  now(): ISODateTime;
}

export interface InvestigationResult {
  engine: InvestigationEngine;
  model?: string;
  fallbackReason?: string;
  verdict: InvestigationVerdict;
}

export interface InvestigatorOptions {
  /** Pause between tool calls in the deterministic fallback, so the timeline animates. */
  stepDelayMs?: number;
}

/**
 * Entry point implemented in src/lib/investigator. Must never throw: on any
 * LLM problem it switches to the deterministic fallback.
 */
export type RunInvestigation = (
  ctx: InvestigationContext,
  tools: InvestigationTools,
  sink: InvestigationSink,
  options?: InvestigatorOptions,
) => Promise<InvestigationResult>;

// ---------------------------------------------------------------------------
// Verification, audit
// ---------------------------------------------------------------------------

export interface VerificationRequest {
  id: string;
  paymentId: string;
  suspiciousSessionId: string;
  /** Never SMS to a recently swapped SIM. */
  channel: "TRUSTED_DEVICE_PUSH";
  /** Null when the customer has no other trusted active session. */
  targetDeviceId: string | null;
  targetSessionId: string | null;
  status: "PENDING" | "CONFIRMED" | "DENIED" | "UNDELIVERABLE";
  message: string;
  createdAt: ISODateTime;
  respondedAt?: ISODateTime;
}

export type Actor =
  | "customer"
  | "bank-simulator"
  | "telco-signal"
  | "risk-engine"
  | "payment-gateway"
  | "policy-gateway"
  | "ai-investigator"
  | "customer-verification";

export interface AuditEntry {
  seq: number;
  /** Simulated time. */
  at: ISODateTime;
  actor: Actor;
  /** SCREAMING_SNAKE_CASE, for example "PAYMENT_HELD" or "HOLD_BYPASS_ATTEMPT". */
  action: string;
  sessionId?: string;
  paymentId?: string;
  detail: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scenarios (demo driver)
// ---------------------------------------------------------------------------

export type ScenarioId = "A" | "B" | "C";
export type ScenarioEventType = "LOGIN" | "SIM_SWAP" | "ADD_BENEFICIARY" | "TRANSFER";

export interface ScenarioStepInfo {
  type: ScenarioEventType;
  /** Short presenter label, for example "Login from new Android". */
  label: string;
  /** Simulated wall-clock time shown in the UI, for example "02:03". */
  clock: string;
  persona: "customer" | "attacker";
}

export interface ScenarioInfo {
  id: ScenarioId;
  title: string;
  description: string;
  expected: string;
  steps: ScenarioStepInfo[];
}

export interface ScenarioProgress {
  id: ScenarioId;
  /** Index of the next step to run. Equals steps.length when finished. */
  nextStep: number;
  totalSteps: number;
  /** Session created by the scenario's LOGIN step, once it ran. */
  actorSessionId: string | null;
}

// ---------------------------------------------------------------------------
// State snapshot (GET /api/state)
// ---------------------------------------------------------------------------

export interface StateSnapshot {
  /** Increases on every state mutation. */
  seq: number;
  /** Simulated clock. */
  now: ISODateTime;
  customer: Customer;
  devices: Device[];
  sessions: Session[];
  beneficiaries: Beneficiary[];
  payments: Payment[];
  /** Latest risk assessment per session id. */
  risk: Record<string, RiskAssessment>;
  sim: SimStatus;
  investigations: Investigation[];
  incidents: Incident[];
  verifications: VerificationRequest[];
  /** Oldest first. */
  audit: AuditEntry[];
  scenarios: ScenarioInfo[];
  scenario: ScenarioProgress | null;
  riskConfig: RiskConfig;
  llm: { configured: boolean; model: string | null };
}

// ---------------------------------------------------------------------------
// HTTP API (all JSON)
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "INVALID_REQUEST" // 400
  | "UNAUTHENTICATED" // 401
  | "SESSION_RESTRICTED" // 403
  | "SESSION_REVOKED" // 403
  | "NOT_TRUSTED_CHANNEL" // 403
  | "NOT_FOUND" // 404
  | "PAYMENT_HELD" // 409
  | "CONFLICT" // 409
  | "INSUFFICIENT_FUNDS"; // 422

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

/**
 * Routes. `Bearer` means header `Authorization: Bearer <session.token>`.
 * `at` is an optional simulated timestamp; default is the simulated clock.
 *
 * GET  /api/state                              -> StateSnapshot
 * POST /api/reset                              -> StateSnapshot (seed data, no scenario)
 * POST /api/scenarios/{id}/start               -> StateSnapshot (reset + scenario preconditions)
 * POST /api/scenarios/next                     -> ScenarioNextResponse (runs the next step of the active scenario)
 * POST /api/login            LoginRequest      -> LoginResponse
 * POST /api/sim-swap         SimSwapRequest    -> { sim: SimStatus }
 * POST /api/beneficiaries    Bearer, AddBeneficiaryRequest -> { beneficiary: Beneficiary; risk: RiskAssessment }
 * POST /api/payments         Bearer, TransferRequest       -> PaymentResponse (200 for every gateway decision, 403 for restricted or revoked sessions)
 * POST /api/payments/{id}/execute   Bearer     -> PaymentResponse, or 409 PAYMENT_HELD. Never bypasses a hold.
 * POST /api/verifications/{id}/respond  Bearer of the TRUSTED target session, VerificationResponseRequest -> VerificationResponse
 */
export interface LoginRequest {
  /** Known device id, or a new id together with `device`. */
  deviceId: string;
  device?: { label: string; platform: Device["platform"] };
  network: NetworkContext;
  at?: ISODateTime;
}
export interface LoginResponse {
  session: Session;
  risk: RiskAssessment;
}

export interface SimSwapRequest {
  swappedAt: ISODateTime;
  at?: ISODateTime;
}

export interface AddBeneficiaryRequest {
  name: string;
  iban: string;
  at?: ISODateTime;
}

export interface TransferRequest {
  beneficiaryId: string;
  amount: number;
  at?: ISODateTime;
}

export interface PaymentResponse {
  payment: Payment;
  risk: RiskAssessment;
  /** Balance after the gateway decision. */
  balance: number;
}

export interface VerificationResponseRequest {
  response: "CONFIRM" | "DENY";
}
export interface VerificationResponse {
  verification: VerificationRequest;
  payment: Payment;
  balance: number;
}

export interface ScenarioNextResponse {
  /** The step that just ran. */
  step: ScenarioStepInfo;
  scenario: ScenarioProgress;
  state: StateSnapshot;
}
