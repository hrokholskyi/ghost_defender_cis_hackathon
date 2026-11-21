/**
 * View-model: maps a StateSnapshot plus local UI state to exactly what the
 * dashboard components render. Pure and deterministic; components stay dumb.
 */
import { RISK_SIGNAL_LABELS } from "@/lib/config";
import {
  RISK_SIGNAL_ORDER,
  type AuditEntry,
  type BeneficiaryCheckResult,
  type DeviceHistoryResult,
  type Incident,
  type InvestigationEngine,
  type InvestigationStep,
  type PaymentHistoryResult,
  type RiskAction,
  type RiskSignal,
  type RiskSignalId,
  type ScenarioEventType,
  type ScenarioId,
  type SessionActivityResult,
  type SimStatusResult,
  type StateSnapshot,
} from "@/lib/types";
import { dateLabel, elapsed, hm, hms, linkify, lockTime, median, minutesBetween, money, type TextPart } from "./format";
import { revealedScore, type Reveal } from "./reveal";
import { heldByGateway, runContext, stepOfSignal, type RunContext } from "./run-context";

// ---------------------------------------------------------------------------
// UI state and view types
// ---------------------------------------------------------------------------

export type PendingRequest = "start" | "next" | "verify" | "retry";

export interface UiState {
  reveal: Reveal;
  pending: PendingRequest | null;
  autoplay: boolean;
  /** False after the last poll failed. */
  reachable: boolean;
  /** Error of the last start / next request. */
  actionError: string | null;
  /** Result of the attacker's "Retry transfer". */
  retry: { status: "idle" | "pending" | "refused" | "done"; message?: string; sessionStatus?: string };
  /** Error of the last answer to the verification push. */
  verifyError: string | null;
}

export type BandId = "low" | "elevated" | "high" | "critical";
export type Variant = "takeover" | "normal" | "newDevice";
export type Tone = "" | "ai" | "protected";
export type NoteTone = "normal" | "key" | "hostile";
export type PresenceTone = "" | "alert" | "hostile" | "blocked" | "active" | "neutral";
export type PresenceIcon = "moon" | "bell" | "dot" | "lock" | "check";
export type TileTone = "" | "warn" | "held" | "restricted" | "open" | "safe";
export type AuditSource = "auth" | "telco" | "session" | "customer" | "gateway" | "agent" | "risk" | "verify";

export interface Chip {
  type: ScenarioEventType;
  status: "idle" | "active" | "done";
  persona: "customer" | "attacker";
}

export interface TopBarView {
  scenarios: Array<{ id: ScenarioId; title: string; active: boolean }>;
  chips: Chip[];
  clock: { hm: string; ss: string };
  nextLabel: string;
  nextDisabled: boolean;
  finished: boolean;
  autoplay: boolean;
  busy: boolean;
  reachable: boolean;
  investigator: string;
  investigatorEngine: InvestigationEngine;
  error: string | null;
}

export interface Presence {
  tone: PresenceTone;
  icon: PresenceIcon;
  label: string;
}

export interface Note {
  text: string;
  tone: NoteTone;
}

export interface AppView {
  screen: "login" | "home" | "beneficiary" | "transfer";
  user: string;
  customerId: string;
  login: { filled: boolean; ok: boolean; success: boolean };
  greeting: string;
  balance: number;
  beneficiary: { name: string; iban: string; added: boolean };
  transfer: {
    amount: number;
    to: string;
    from: number;
    status: "draft" | "sending" | "held" | "settled" | "cancelled" | "pending" | "rejected";
  };
  simFlag: boolean;
  lockout: null | {
    kind: "restricted" | "revoked";
    title: string;
    sub: string;
    retry: { pressed: boolean; busy: boolean; refused: string | null };
  };
}

export interface PushView {
  title: string;
  body: string;
  state: "pending" | "sending" | "denied" | "confirmed";
  error: string | null;
}

export interface CustomerView {
  role: string;
  name: string;
  sub: string;
  presence: Presence;
  phone: {
    mode: "lock" | "app";
    awake: boolean;
    status: "no-service" | "bars";
    serviceAlert: boolean;
    lockTime: string;
    lockDate: string;
    widget: { balance: number; status: string; protected: boolean };
    push: PushView | null;
    app: AppView | null;
  };
  note: Note;
}

export interface SideView {
  kind: "attacker" | "newDevice" | "empty";
  role: string;
  title: string;
  sub: string;
  presence: Presence;
  phone: null | { platform: "android" | "iphone"; time: string; app: AppView };
  empty: null | { title: string; text: string };
  note: Note;
}

export interface Tile {
  tone: TileTone;
  value: string;
  sub: string;
}

export interface SignalRow {
  id: RiskSignalId;
  label: string;
  points: number;
  detail: string;
  title: string;
  fired: boolean;
  band: BandId | "";
}

export interface BandRow {
  id: BandId;
  min: number;
  max: number;
  label: string;
  action: string;
  current: boolean;
}

export type InvestigationItem =
  | { kind: "tool"; id: string; name: string; status: "running" | "ok" | "error"; result: string }
  | { kind: "note"; id: string; parts: TextPart[] };

export interface InvestigationView {
  engine: InvestigationEngine;
  /** True when an investigation exists for this run (running, completed or failed). */
  active: boolean;
  badge: string;
  fallbackReason: string | null;
  items: InvestigationItem[];
  emptyText: string;
  progress: null | { label: string; elapsed: string; note: string };
  verdict: null | { title: string; text: string; action: string | null; by: string; failed: boolean };
  verdictEmpty: string;
}

export interface AuditRow {
  key: string;
  time: string;
  text: string;
  title: string;
  source: AuditSource;
  sourceLabel: string;
}

export interface AuditFullRow {
  seq: number;
  time: string;
  actor: string;
  action: string;
  detail: string;
}

export interface View {
  variant: Variant;
  scenarioId: ScenarioId | null;
  band: BandId;
  moment: null | { kind: "hold" | "restrict"; title: string; sub: string; by: string };
  topbar: TopBarView;
  caption: { kicker: string; tone: Tone; text: string };
  finale: null | { title: string; line: string; tone: "protected" | "calm" | "neutral" };
  customer: CustomerView;
  side: SideView;
  risk: {
    score: number;
    band: BandId;
    bandLabel: string;
    bands: BandRow[];
    signals: SignalRow[];
    disclaimer: string;
  };
  actions: { payment: Tile; session: Tile; incident: Tile };
  investigation: InvestigationView;
  audit: { recent: AuditRow[]; all: AuditFullRow[] };
}

// ---------------------------------------------------------------------------
// Static texts
// ---------------------------------------------------------------------------

const BAND_TEXT: Record<BandId, { label: string; action: string; kicker: string }> = {
  low: { label: "Low", action: "Monitor", kicker: "Monitor" },
  elevated: { label: "Elevated", action: "Extra verification", kicker: "Extra verification" },
  high: { label: "High", action: "Hold payment", kicker: "Hold payment" },
  critical: { label: "Critical", action: "Hold + restrict session + incident", kicker: "Restrict session" },
};

const SIGNAL_HINTS: Record<RiskSignalId, string> = {
  UNKNOWN_DEVICE: "Session on a device never seen before",
  RECENT_SIM_SWAP: "Telco reports a new SIM on this number",
  UNUSUAL_NETWORK: "Network or location unlike the customer",
  NEW_BENEFICIARY: "Payee added in the current session",
  UNUSUAL_AMOUNT: "Far above the typical transfer",
  RAPID_SEQUENCE: "Login, new payee and transfer in minutes",
};

export const ENGINES: Record<
  InvestigationEngine,
  { badge: string; verdictBy: string; source: string; started: string; kicker: string; running: string; status: string }
> = {
  devin: {
    badge: "Devin session",
    verdictBy: "Devin verdict",
    source: "Devin",
    started: "Devin investigation session started",
    kicker: "Devin investigation",
    running: "Devin is investigating",
    status: "Investigator: Devin",
  },
  "deterministic-fallback": {
    badge: "Deterministic fallback - no LLM",
    verdictBy: "Fallback verdict",
    source: "Fallback",
    started: "Fallback investigation started",
    kicker: "Fallback investigation",
    running: "Fallback investigation running",
    status: "Investigator: deterministic fallback",
  },
};

/** Short names for the presenter's scenario switch. */
const SCENARIO_SHORT_TITLES: Record<ScenarioId, string> = {
  A: "Normal customer",
  B: "Account takeover",
  C: "Phone change",
};

const ASSESSMENT_TITLES = {
  LIKELY_ACCOUNT_TAKEOVER: "Likely account takeover",
  SUSPICIOUS: "Suspicious session",
  LIKELY_LEGITIMATE: "Likely legitimate",
} as const;

const ACTION_LABELS: Record<RiskAction, string> = {
  ALLOW: "Allow and monitor",
  STEP_UP: "Extra verification",
  HOLD: "Hold payment",
  HOLD_AND_RESTRICT: "Hold payment + restrict session",
};

const ACTOR_LABELS: Record<string, string> = {
  customer: "Logged-in session",
  "bank-simulator": "Bank simulator",
  "telco-signal": "Telco signal",
  "risk-engine": "Risk engine",
  "payment-gateway": "Payment gateway",
  "policy-gateway": "Policy gateway",
  "ai-investigator": "AI investigator",
  "customer-verification": "Customer verification",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function bandFor(score: number, t: StateSnapshot["riskConfig"]["thresholds"]): BandId {
  if (score >= t.critical) return "critical";
  if (score >= t.high) return "high";
  if (score >= t.elevated) return "elevated";
  return "low";
}

function variantFor(id: ScenarioId | undefined, ctx: RunContext): Variant {
  if (id === "A") return "normal";
  if (id === "B") return "takeover";
  if (id === "C") return "newDevice";
  const first = ctx.info?.steps[0];
  if (first?.persona === "attacker") return "takeover";
  return ctx.actorDevice && !ctx.actorDevice.trusted ? "newDevice" : "normal";
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}

function shortName(full: string): string {
  const [first, last] = full.split(/\s+/);
  return last ? `${first} ${last[0]}.` : first;
}

function typicalAmount(s: StateSnapshot, excludeId?: string): number {
  return median(s.payments.filter((p) => p.status === "SETTLED" && p.id !== excludeId).map((p) => p.amount));
}

function stepIndex(ctx: RunContext, type: ScenarioEventType): number {
  return ctx.info?.steps.findIndex((x) => x.type === type) ?? -1;
}

/** True once the arrival beat of the given step type has passed. */
function settledStep(ctx: RunContext, r: Reveal, type: ScenarioEventType): boolean {
  const i = stepIndex(ctx, type);
  return i >= 0 && r.steps > i;
}

function arrivedStep(ctx: RunContext, type: ScenarioEventType): boolean {
  const i = stepIndex(ctx, type);
  return i >= 0 && ctx.arrived > i;
}

type PaymentShown = "none" | "requested" | "held" | "pending" | "settled" | "cancelled" | "rejected";
type SessionShown = "none" | "active" | "restricted" | "revoked";

interface Derived {
  s: StateSnapshot;
  ui: UiState;
  r: Reveal;
  ctx: RunContext;
  variant: Variant;
  score: number;
  band: BandId;
  revealed: RiskSignal[];
  paymentShown: PaymentShown;
  sessionShown: SessionShown;
  restrictionLifted: boolean;
  incidentVisible: boolean;
  verdictShown: boolean;
  customerName: string;
  beneficiaryName: string;
  amount: number;
}

function paymentShown(ctx: RunContext, r: Reveal): PaymentShown {
  const p = ctx.payment;
  if (!p) return "none";
  if (!settledStep(ctx, r, "TRANSFER") && ctx.info?.steps.some((x) => x.type === "TRANSFER")) return "requested";
  if (heldByGateway(p) && r.hold === "pending") return "requested";
  switch (p.status) {
    case "HELD":
      return "held";
    case "PENDING_VERIFICATION":
      return "pending";
    case "SETTLED":
      return "settled";
    case "CANCELLED":
      return "cancelled";
    case "REJECTED":
      return "rejected";
  }
}

function sessionShown(ctx: RunContext, r: Reveal): SessionShown {
  const session = ctx.actorSession;
  if (!session) return "none";
  if (session.status === "REVOKED") return "revoked";
  if (session.status === "RESTRICTED") {
    if (ctx.payment?.action === "HOLD_AND_RESTRICT" && r.restrict === "pending") return "active";
    if (ctx.payment?.action !== "HOLD_AND_RESTRICT" && !r.gate) return "active";
    return "restricted";
  }
  return "active";
}

function derive(s: StateSnapshot, ui: UiState): Derived {
  const ctx = runContext(s);
  const r = ui.reveal;
  const variant = variantFor(s.scenario?.id, ctx);
  const score = revealedScore(s, r);
  const revealed = (ctx.assessment?.signals ?? []).filter((x) => r.signals.includes(x.id));
  const inv = ctx.investigation;
  const toolStepsShown = Math.min(r.toolSteps, inv?.steps.length ?? 0);
  const allStepsShown = !!inv && toolStepsShown >= inv.steps.length;
  const incidentStepShown =
    !!inv &&
    inv.steps.slice(0, toolStepsShown).some((x) => x.kind === "tool_call" && x.tool === "create_incident" && x.status !== "running");
  return {
    s,
    ui,
    r,
    ctx,
    variant,
    score,
    band: bandFor(score, s.riskConfig.thresholds),
    revealed,
    paymentShown: paymentShown(ctx, r),
    sessionShown: sessionShown(ctx, r),
    restrictionLifted: !!ctx.actorSession && s.audit.some((e) => e.action === "SESSION_RESTRICTION_LIFTED" && e.sessionId === ctx.actorSession?.id),
    incidentVisible: !!ctx.incident && r.gate && (!inv || allStepsShown || incidentStepShown),
    verdictShown: !!inv && inv.status !== "RUNNING" && allStepsShown && r.gate,
    customerName: s.customer.name,
    beneficiaryName: ctx.beneficiary?.name ?? "",
    amount: ctx.payment?.amount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function topbar(d: Derived): TopBarView {
  const { s, ui, ctx } = d;
  const steps = ctx.info?.steps ?? [];
  const finished = !!s.scenario && ctx.arrived >= ctx.total;
  const finale = finaleFor(d);
  const chips: Chip[] = steps.map((step, i) => ({
    type: step.type,
    persona: step.persona,
    status: i < ctx.arrived - 1 || (i === ctx.arrived - 1 && finale) ? "done" : i === ctx.arrived - 1 ? "active" : "idle",
  }));
  const next = steps[ctx.arrived];
  const now = hms(s.now);
  const engine: InvestigationEngine = s.llm.configured ? "devin" : "deterministic-fallback";
  return {
    scenarios: s.scenarios.map((x) => ({ id: x.id, title: SCENARIO_SHORT_TITLES[x.id] ?? x.title, active: x.id === s.scenario?.id })),
    chips,
    clock: { hm: now.slice(0, 5), ss: now.slice(6) },
    nextLabel: next ? `Next: ${next.type}` : s.scenario ? "Finished" : "Next",
    nextDisabled: !next || ui.pending !== null,
    finished,
    autoplay: ui.autoplay,
    busy: ui.pending !== null,
    reachable: ui.reachable,
    investigator: s.llm.configured && s.llm.model ? `${ENGINES.devin.status} (${s.llm.model})` : ENGINES[engine].status,
    investigatorEngine: engine,
    error: ui.actionError,
  };
}

function riskKicker(d: Derived): string {
  return `Risk ${d.score} - ${BAND_TEXT[d.band].label} - ${BAND_TEXT[d.band].kicker}`;
}

function signalCaption(d: Derived, id: RiskSignalId): string {
  const { s, ctx } = d;
  const name = firstName(d.customerName);
  const { high, critical } = s.riskConfig.thresholds;
  switch (id) {
    case "UNKNOWN_DEVICE":
      return "A new device alone is not proof of fraud. People buy new phones. The engine keeps watching.";
    case "RECENT_SIM_SWAP": {
      const m = s.sim.swappedAt && ctx.actorSession ? minutesBetween(s.sim.swappedAt, ctx.actorSession.createdAt) : null;
      return m !== null
        ? `The SIM was swapped ${m} minutes before login. The SMS code no longer proves it is ${name}.`
        : `The SIM was swapped shortly before login. The SMS code no longer proves it is ${name}.`;
    }
    case "UNUSUAL_NETWORK":
      return "The network is unlike the customer's usual one.";
    case "NEW_BENEFICIARY":
      return d.revealed.some((x) => x.id === "RECENT_SIM_SWAP")
        ? "Unknown device, new SIM, new payee. Any payment now needs extra checks."
        : "A payee added in this session. Any payment now needs extra checks.";
    case "UNUSUAL_AMOUNT": {
      const typical = typicalAmount(s, ctx.payment?.id);
      const ratio = typical > 0 ? Math.round(d.amount / typical) : null;
      const crosses = d.score >= high ? ` Risk crosses ${high}.` : "";
      return ratio !== null
        ? `The amount is ${ratio} times her typical transfer.${crosses}`
        : `The amount is far above the typical transfer.${crosses}`;
    }
    case "RAPID_SEQUENCE": {
      const m =
        ctx.actorSession && ctx.payment ? minutesBetween(ctx.actorSession.createdAt, ctx.payment.requestedAt) : null;
      const crosses = d.score >= critical ? ` Risk crosses ${critical}.` : "";
      return `Login, new payee and a large transfer in ${m ?? "a few"} minutes.${crosses}`;
    }
  }
}

function caption(d: Derived): View["caption"] {
  const { s, ctx, r, variant } = d;
  const name = firstName(d.customerName);
  const steps = ctx.info?.steps ?? [];
  const k = ctx.arrived;
  if (!s.scenario) return { kicker: "Simulator", tone: "", text: "No scenario is active. Choose one in the top bar." };

  if (k === 0) {
    const at = hm(s.now);
    if (variant === "takeover")
      return { kicker: "Before the attack", tone: "", text: `${at} at night. ${name} is asleep and her trusted iPhone is idle.` };
    if (variant === "normal")
      return { kicker: "Before the payment", tone: "", text: `${at}. ${name} is at home with her trusted iPhone.` };
    return { kicker: "Before the login", tone: "", text: `${at}. ${name} unpacks her new phone at home.` };
  }

  const step = steps[k - 1];
  const stepKicker = `Step ${k} of ${steps.length} - ${step.type}`;
  const settled = r.steps >= k;
  const ofThisStep = d.revealed.filter((x) => stepOfSignal(x, ctx.info) === k);
  const lastSignal = ofThisStep[ofThisStep.length - 1];

  // After the last scripted event: the investigation and the customer take over.
  const inv = ctx.investigation;
  if (step.type === "TRANSFER" && r.gate && inv && !d.restrictionLifted) {
    const eng = ENGINES[inv.engine];
    if (inv.status === "RUNNING" || !d.verdictShown)
      return { kicker: eng.kicker, tone: "ai", text: "The agent calls tools to collect evidence. The money is already safe." };
    if (inv.status === "FAILED")
      return { kicker: "Investigation failed", tone: "ai", text: "The protective actions stay in place. Code took them, not the agent." };
    return { kicker: eng.verdictBy, tone: "ai", text: "The agent explains the decision from its tool results. Code took the actions." };
  }

  if (settled && lastSignal) return { kicker: riskKicker(d), tone: "", text: signalCaption(d, lastSignal.id) };

  const ben = d.beneficiaryName;
  const amount = money(d.amount);
  switch (step.type) {
    case "LOGIN":
      if (variant === "takeover")
        return { kicker: stepKicker, tone: "", text: `An unknown phone signs in to ${name}'s account with her phished password.` };
      if (variant === "normal")
        return settled
          ? { kicker: riskKicker(d), tone: "", text: "Known device, home network, no SIM change. Nothing to flag." }
          : { kicker: stepKicker, tone: "", text: `${name} signs in on her own trusted iPhone, from home.` };
      return { kicker: stepKicker, tone: "", text: `${name} signs in from a new ${ctx.actorDevice?.label ?? "phone"} at home. No SIM swap.` };
    case "SIM_SWAP":
      return { kicker: stepKicker, tone: "", text: `A telco signal arrives for ${name}'s phone number.` };
    case "ADD_BENEFICIARY":
      return { kicker: stepKicker, tone: "", text: `The session adds a new beneficiary: ${ben}.` };
    case "TRANSFER":
      if (variant === "takeover") return { kicker: stepKicker, tone: "", text: `The attacker requests ${amount} to ${ben}.` };
      if (d.paymentShown === "settled")
        return { kicker: riskKicker(d), tone: "", text: `Known payee, usual amount. The gateway allows ${amount} at once.` };
      return { kicker: stepKicker, tone: "", text: `${name} sends ${amount} to ${ben}, a payee she has paid before.` };
  }
}

function finaleFor(d: Derived): View["finale"] {
  const { ctx, variant } = d;
  if (!ctx.payment) return null;
  if (variant === "takeover") {
    if (ctx.verification?.status === "CONFIRMED" && d.paymentShown === "settled") {
      return {
        tone: "neutral",
        title: `CUSTOMER CONFIRMED • ${money(d.amount)} RELEASED (SIMULATION)`,
        line: "Customer confirmed on the trusted device. Payment released.",
      };
    }
    const contained = d.paymentShown === "held" || d.paymentShown === "cancelled";
    const blocked = d.sessionShown === "restricted" || d.sessionShown === "revoked";
    if (contained && blocked && d.incidentVisible && d.verdictShown) {
      return {
        tone: "protected",
        title: `ACCOUNT TAKEOVER CONTAINED • ${money(d.amount)} PROTECTED (SIMULATION)`,
        line: "Password correct. SMS code correct. Login successful. The agent still spotted a stranger's session and stopped the transfer before the money left.",
      };
    }
    return null;
  }
  if (d.paymentShown !== "settled") return null;
  if (variant === "normal") {
    return {
      tone: "protected",
      title: `NORMAL CUSTOMER • ${money(d.amount)} SETTLED (SIMULATION)`,
      line: "Legitimate payment approved. No friction for the real customer.",
    };
  }
  return {
    tone: "calm",
    title: `NEW PHONE • ${money(d.amount)} SETTLED (SIMULATION)`,
    line: "New device alone is not proof of fraud. Payment approved, session monitored.",
  };
}

function appView(d: Derived): AppView {
  const { s, ctx, r } = d;
  const steps = ctx.info?.steps ?? [];
  const last = steps[ctx.arrived - 1];
  let screen: AppView["screen"] = "login";
  if (last) {
    if (last.type === "LOGIN") screen = r.steps >= ctx.arrived ? "home" : "login";
    else if (last.type === "SIM_SWAP") screen = "home";
    else if (last.type === "ADD_BENEFICIARY") screen = "beneficiary";
    else screen = "transfer";
  }
  const loggedIn = arrivedStep(ctx, "LOGIN");
  const ben = ctx.beneficiary;
  const statusMap: Record<PaymentShown, AppView["transfer"]["status"]> = {
    none: "draft",
    requested: "sending",
    held: "held",
    pending: "pending",
    settled: "settled",
    cancelled: "cancelled",
    rejected: "rejected",
  };
  const shownBalance = displayedBalance(d);
  let lockout: AppView["lockout"] = null;
  if (d.sessionShown === "restricted" || d.sessionShown === "revoked") {
    const revoked = d.sessionShown === "revoked";
    lockout = {
      kind: revoked ? "revoked" : "restricted",
      title: revoked ? "Session ended" : "Session restricted",
      sub: revoked
        ? "The account owner denied the payment on her trusted device. This session is revoked."
        : "Payments are blocked in this session. The transfer is on hold - under review.",
      retry: (() => {
        // A result only counts for the session state it was refused in.
        const current = !d.ui.retry.sessionStatus || d.ui.retry.sessionStatus === ctx.actorSession?.status;
        return {
          pressed: current && d.ui.retry.status !== "idle",
          busy: d.ui.retry.status === "pending",
          refused: current && d.ui.retry.status === "refused" ? (d.ui.retry.message ?? "Request refused") : null,
        };
      })(),
    };
  }
  return {
    screen,
    user: loggedIn ? shortName(d.customerName) : "",
    customerId: d.customerName.toLowerCase().replace(/\s+/g, "."),
    login: { filled: loggedIn, ok: loggedIn, success: loggedIn },
    greeting: `Welcome back, ${firstName(d.customerName)}`,
    balance: shownBalance,
    beneficiary: {
      name: ben?.name ?? "",
      iban: ben?.iban ?? "",
      added: settledStep(ctx, r, "ADD_BENEFICIARY"),
    },
    transfer: {
      amount: d.amount,
      to: d.beneficiaryName,
      from: d.paymentShown === "settled" ? shownBalance + d.amount : shownBalance,
      status: statusMap[d.paymentShown],
    },
    simFlag: s.sim.swapConfirmed && (d.r.signals.includes("RECENT_SIM_SWAP") || settledStep(ctx, r, "SIM_SWAP")),
    lockout,
  };
}

/** Balance as shown: a settled payment is not shown as debited before its arrival beat. */
function displayedBalance(d: Derived): number {
  const p = d.ctx.payment;
  if (p && p.status === "SETTLED" && d.paymentShown !== "settled") return d.s.customer.balance + p.amount;
  return d.s.customer.balance;
}

function pushView(d: Derived): PushView | null {
  const v = d.ctx.verification;
  if (!v || !d.r.gate || v.status === "UNDELIVERABLE") return null;
  const amount = money(d.amount);
  if (v.status === "DENIED")
    return {
      title: "You said it wasn't you",
      body: "Payment cancelled and the other session signed out. Nothing was debited.",
      state: "denied",
      error: null,
    };
  if (v.status === "CONFIRMED")
    return { title: "Thanks. Payment released", body: `${amount} sent to ${d.beneficiaryName}.`, state: "confirmed", error: null };
  return {
    title: `Did you request ${amount} to ${d.beneficiaryName}?`,
    body: "We held this payment. No money has left your account.",
    state: d.ui.pending === "verify" ? "sending" : "pending",
    error: d.ui.verifyError,
  };
}

function customer(d: Derived): CustomerView {
  const { s, ctx, variant } = d;
  const device = ctx.trustedDevice;
  const push = variant === "takeover" ? pushView(d) : null;
  const name = firstName(d.customerName);
  const balance = displayedBalance(d);

  let widgetStatus = "No recent activity";
  let widgetProtected = false;
  if (d.paymentShown === "held" || d.paymentShown === "pending") {
    widgetStatus = "Unchanged - nothing debited";
    widgetProtected = true;
  } else if (d.paymentShown === "cancelled") {
    widgetStatus = "Unchanged - transfer cancelled";
    widgetProtected = true;
  } else if (d.paymentShown === "settled") {
    widgetStatus = `${money(d.amount)} to ${d.beneficiaryName}`;
  }

  let presence: Presence = { tone: "", icon: "moon", label: "Asleep" };
  let note: Note = { text: "", tone: "normal" };
  const mode: "lock" | "app" = variant === "normal" && arrivedStep(ctx, "LOGIN") ? "app" : "lock";

  if (variant === "takeover") {
    note = { text: `Her phone has had no service since ${hm(s.sim.swappedAt ?? "") === "--:--" ? "01:15" : hm(s.sim.swappedAt)}. She has not noticed.`, tone: "normal" };
    if (push) {
      presence = { tone: "alert", icon: "bell", label: "Notified" };
      note = { text: "Verification goes to the trusted device by push, not by SMS to the swapped SIM.", tone: "key" };
    }
    if (push?.state === "denied") {
      presence = { tone: "alert", icon: "check", label: "Denied it" };
      note = { text: `${name} denied it on her trusted iPhone. The payment is cancelled and the other session is revoked.`, tone: "key" };
    } else if (push?.state === "confirmed") {
      presence = { tone: "active", icon: "check", label: "Confirmed" };
      note = { text: `${name} confirmed the payment on her trusted iPhone. The bank released it.`, tone: "key" };
    }
  } else if (variant === "normal") {
    presence = mode === "app" ? { tone: "active", icon: "dot", label: "Using the app" } : { tone: "", icon: "dot", label: "Idle" };
    note = { text: `Pays her rent instalment from her own phone, as every month.`, tone: "normal" };
    if (d.paymentShown === "settled") note = { text: "Known device, known payee, usual amount. No extra checks needed.", tone: "key" };
  } else {
    presence = { tone: "", icon: "dot", label: "Idle" };
    note = { text: `Her old ${device?.label ?? "iPhone"} stays on file as a trusted device.`, tone: "normal" };
  }

  return {
    role: "Real customer",
    name: d.customerName,
    sub: `${device?.label ?? "iPhone"}, trusted device`,
    presence,
    phone: {
      mode,
      awake: mode === "app" || !!push,
      status: variant === "takeover" ? "no-service" : "bars",
      serviceAlert: variant === "takeover" && (d.r.signals.includes("RECENT_SIM_SWAP") || settledStep(ctx, d.r, "SIM_SWAP")),
      lockTime: lockTime(s.now),
      lockDate: dateLabel(s.now),
      widget: { balance, status: widgetStatus, protected: widgetProtected },
      push,
      app: mode === "app" ? appView(d) : null,
    },
    note,
  };
}

function side(d: Derived): SideView {
  const { s, ctx, variant } = d;
  const name = firstName(d.customerName);
  const time = hm(s.now);

  if (variant === "normal") {
    return {
      kind: "empty",
      role: "Other sessions",
      title: "None",
      sub: "No unknown device on this account",
      presence: { tone: "neutral", icon: "check", label: "Clear" },
      phone: null,
      empty: { title: "No other session", text: `Only ${name}'s trusted iPhone is signed in. Nothing to contain.` },
      note: { text: "The defender stays out of the way when nothing is wrong.", tone: "normal" },
    };
  }

  const presenceFor = (): Presence => {
    switch (d.sessionShown) {
      case "none":
        return { tone: "", icon: "dot", label: "Signing in" };
      case "active":
        return variant === "takeover"
          ? { tone: "hostile", icon: "dot", label: "Logged in" }
          : { tone: "neutral", icon: "dot", label: d.paymentShown === "settled" ? "Monitored" : "Logged in" };
      case "restricted":
        return { tone: "blocked", icon: "lock", label: "Restricted" };
      case "revoked":
        return { tone: "blocked", icon: "lock", label: "Signed out" };
    }
  };

  if (variant === "newDevice") {
    const label = ctx.actorDevice?.label ?? "iPhone 16";
    return {
      kind: "newDevice",
      role: "New device",
      title: label,
      sub: ctx.actorDevice?.firstSeenAt ? `Same customer, first seen ${hm(ctx.actorDevice.firstSeenAt)}` : "Same customer, new phone",
      presence: presenceFor(),
      phone: { platform: "iphone", time, app: appView(d) },
      empty: null,
      note:
        d.paymentShown === "settled"
          ? { text: "Allowed at low risk. The session stays active and monitored.", tone: "key" }
          : { text: `Bought a new ${label} today. Same SIM, same home network.`, tone: "normal" },
    };
  }

  let note: Note = { text: `Has ${name}'s password, phished by a fake bank SMS earlier today.`, tone: "hostile" };
  if (d.r.signals.includes("RECENT_SIM_SWAP"))
    note = { text: `Receives ${name}'s SMS codes on the swapped SIM. That is how the code was correct.`, tone: "hostile" };
  if (d.sessionShown === "restricted")
    note = { text: "The transfer is frozen and the session can no longer move money.", tone: "hostile" };
  if (d.sessionShown === "revoked") note = { text: "The session is revoked. The attacker is signed out for good.", tone: "hostile" };
  if (d.restrictionLifted) note = { text: `${name} confirmed this transfer was hers, so the restriction is lifted.`, tone: "normal" };

  const device = ctx.actorDevice ?? s.devices.find((x) => !x.trusted);
  return {
    kind: "attacker",
    role: "Attacker",
    title: "Unknown device",
    sub: device ? `${device.label}, first seen tonight` : "Samsung Galaxy A54, first seen tonight",
    presence: presenceFor(),
    phone: { platform: "android", time, app: appView(d) },
    empty: null,
    note,
  };
}

function signalDetail(d: Derived, sig: RiskSignal): string {
  const { s, ctx } = d;
  switch (sig.id) {
    case "UNKNOWN_DEVICE": {
      const dev = ctx.actorDevice;
      return dev?.firstSeenAt ? `${dev.label}, first seen at ${hm(dev.firstSeenAt)}` : sig.evidence;
    }
    case "RECENT_SIM_SWAP": {
      const login = ctx.actorSession?.createdAt;
      return s.sim.swappedAt && login
        ? `SIM swapped at ${hm(s.sim.swappedAt)}, ${minutesBetween(s.sim.swappedAt, login)} min before login`
        : sig.evidence;
    }
    case "NEW_BENEFICIARY": {
      const ben = s.beneficiaries.find((b) => b.createdBySessionId === ctx.actorSession?.id);
      return ben ? `${ben.name}, added in this session` : sig.evidence;
    }
    case "UNUSUAL_AMOUNT": {
      const typical = typicalAmount(s, ctx.payment?.id);
      if (!ctx.payment || typical <= 0) return sig.evidence;
      return `${money(ctx.payment.amount)} vs typical ${money(typical)} (${Math.round(ctx.payment.amount / typical)}x)`;
    }
    case "RAPID_SEQUENCE": {
      const login = ctx.actorSession?.createdAt;
      return login && ctx.payment ? `Login to transfer in ${minutesBetween(login, ctx.payment.requestedAt)} minutes` : sig.evidence;
    }
    default:
      return sig.evidence;
  }
}

function risk(d: Derived): View["risk"] {
  const { s } = d;
  const t = s.riskConfig.thresholds;
  const bands: BandRow[] = [
    { id: "low", min: 0, max: t.elevated - 1 },
    { id: "elevated", min: t.elevated, max: t.high - 1 },
    { id: "high", min: t.high, max: t.critical - 1 },
    { id: "critical", min: t.critical, max: 100 },
  ].map((b) => ({ ...b, id: b.id as BandId, ...BAND_TEXT[b.id as BandId], current: b.id === d.band }));
  const signals: SignalRow[] = RISK_SIGNAL_ORDER.map((id) => {
    const fired = d.revealed.find((x) => x.id === id);
    return {
      id,
      label: fired?.label ?? RISK_SIGNAL_LABELS[id],
      points: s.riskConfig.weights[id],
      detail: fired ? signalDetail(d, fired) : SIGNAL_HINTS[id],
      title: fired ? fired.evidence : SIGNAL_HINTS[id],
      fired: !!fired,
      band: fired ? bandFor(fired.cumulative, t) : "",
    };
  });
  return {
    score: d.score,
    band: d.band,
    bandLabel: BAND_TEXT[d.band].label,
    bands,
    signals,
    disclaimer: s.riskConfig.disclaimer,
  };
}

function incidentSub(incident: Incident): string {
  switch (incident.status) {
    case "OPEN":
      return "Open";
    case "CONFIRMED_ATO":
      return "Confirmed takeover";
    case "RESOLVED_LEGITIMATE":
      return "Resolved - legitimate";
  }
}

function actions(d: Derived): View["actions"] {
  const { ctx, variant } = d;
  const amount = money(d.amount);
  const paymentTiles: Record<PaymentShown, Tile> = {
    none: { tone: "", value: "None", sub: "No payment yet" },
    requested: { tone: "warn", value: amount, sub: "Requested" },
    held: { tone: "held", value: "On hold", sub: "Before debit" },
    pending: { tone: "warn", value: "Pending", sub: "Awaiting verification" },
    settled: {
      tone: "safe",
      value: "Settled",
      sub: ctx.verification?.status === "CONFIRMED" ? "Released by the customer" : `${amount}, allowed`,
    },
    cancelled: { tone: "safe", value: "Cancelled", sub: "Nothing debited" },
    rejected: { tone: "restricted", value: "Rejected", sub: "Refused by the gateway" },
  };
  const trusted = !!ctx.actorDevice?.trusted;
  const sessionTiles: Record<SessionShown, Tile> = {
    none: { tone: "", value: "None", sub: "Not logged in" },
    active: d.restrictionLifted
      ? { tone: "warn", value: "Active", sub: "Restriction lifted" }
      : { tone: "warn", value: "Active", sub: trusted ? "Trusted device" : "Monitored" },
    restricted: { tone: "restricted", value: "Restricted", sub: "No payments" },
    revoked: { tone: "restricted", value: "Revoked", sub: "Signed out" },
  };
  const incident = ctx.incident;
  let incidentTile: Tile = {
    tone: "",
    value: "None",
    sub: variant !== "takeover" && d.paymentShown === "settled" ? "Not needed" : "Not opened",
  };
  if (incident && d.incidentVisible) {
    incidentTile = {
      tone: incident.status === "RESOLVED_LEGITIMATE" ? "safe" : "open",
      value: incident.id,
      sub: incidentSub(incident),
    };
  }
  return { payment: paymentTiles[d.paymentShown], session: sessionTiles[d.sessionShown], incident: incidentTile };
}

// ---------------------------------------------------------------------------
// Investigation
// ---------------------------------------------------------------------------

export function summarizeTool(step: Extract<InvestigationStep, { kind: "tool_call" }>): string {
  if (step.status === "running") return "running...";
  if (step.status === "error") return `Error: ${step.error ?? "tool call failed"}`;
  const out = step.output;
  if (!out || typeof out !== "object") return "Done.";
  try {
    switch (step.tool) {
      case "get_device_history": {
        const r = out as DeviceHistoryResult;
        const known = r.knownDevices.map((x) => x.label).join(", ");
        const current = `${r.currentDevice.label}: ${r.currentDevice.known ? "known device" : "unknown device"}.`;
        return known && !r.currentDevice.known ? `${current} ${known}: trusted.` : current;
      }
      case "get_sim_status": {
        const r = out as SimStatusResult;
        if (!r.available) return "SIM status unavailable: no signal source answered.";
        if (!r.swapConfirmed) return "No SIM swap reported for this number (synthetic signal).";
        return r.minutesBeforeLogin !== null
          ? `SIM swap confirmed ${r.minutesBeforeLogin} min before login (synthetic signal).`
          : "SIM swap confirmed (synthetic signal).";
      }
      case "get_session_activity": {
        const r = out as SessionActivityResult;
        const names: Record<string, string> = {
          LOGIN_SUCCEEDED: "Login",
          BENEFICIARY_ADDED: "new beneficiary",
          PAYMENT_REQUESTED: "transfer",
        };
        const chain = r.events.map((e) => names[e.type]).filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
        const head = chain.length ? chain.join(" -> ") : "Session activity read";
        return r.minutesFromLoginToTransfer !== null
          ? `${head} within ${r.minutesFromLoginToTransfer} minute${r.minutesFromLoginToTransfer === 1 ? "" : "s"}.`
          : `${head}.`;
      }
      case "get_payment_history": {
        const r = out as PaymentHistoryResult;
        if (r.settledCount === 0) return `No settled history; this one is ${money(r.currentAmount)}.`;
        return `Typical transfer about ${money(r.typicalAmount)}; this one is ${money(r.currentAmount)}.`;
      }
      case "check_beneficiary": {
        const r = out as BeneficiaryCheckResult;
        if (r.knownBefore) return `${r.name}: known payee, ${r.priorSettledPayments} earlier payments.`;
        return `${r.name}: never paid before${r.addedInThisSession ? ", added in this session" : ""}.`;
      }
      case "create_incident": {
        const r = out as Incident;
        return `${r.id} opened.`;
      }
    }
  } catch {
    return "Done.";
  }
  return "Done.";
}

function investigation(d: Derived): InvestigationView {
  const { s, ctx, r, variant } = d;
  const inv = ctx.investigation;
  const engine: InvestigationEngine = inv?.engine ?? (s.llm.configured ? "devin" : "deterministic-fallback");
  const eng = ENGINES[engine];
  const visible = !!inv && r.gate;
  const items: InvestigationItem[] = visible
    ? inv.steps.slice(0, r.toolSteps).map((step) =>
        step.kind === "note"
          ? { kind: "note", id: step.id, parts: linkify(step.text) }
          : { kind: "tool", id: step.id, name: `${step.tool}()`, status: step.status, result: summarizeTool(step) },
      )
    : [];

  let emptyText = "Waiting. The agent starts once the gateway has acted.";
  if (variant !== "takeover" && d.paymentShown === "settled")
    emptyText = "Not needed. The gateway allowed the payment at low risk.";

  let progress: InvestigationView["progress"] = null;
  if (visible && inv.status === "RUNNING") {
    const protections: string[] = [];
    if (d.paymentShown === "held") protections.push("payment held");
    if (d.sessionShown === "restricted") protections.push("session restricted");
    progress = {
      label: eng.running,
      elapsed: elapsed(inv.startedAt, s.now),
      note: protections.length
        ? `Protection did not wait: ${protections.join(" and ")} by code.`
        : "Protection did not wait for the agent.",
    };
  }

  let verdict: InvestigationView["verdict"] = null;
  if (inv && d.verdictShown) {
    if (inv.status === "FAILED" || !inv.verdict) {
      verdict = {
        title: "Investigation failed",
        text: "The agent could not finish. The payment hold and the session restriction stay in place, because code applied them.",
        action: null,
        by: eng.verdictBy,
        failed: true,
      };
    } else {
      verdict = {
        title: ASSESSMENT_TITLES[inv.verdict.assessment],
        text: inv.verdict.summary,
        action: ACTION_LABELS[inv.verdict.recommendedAction],
        by: eng.verdictBy,
        failed: false,
      };
    }
  }

  return {
    engine,
    active: visible,
    badge: eng.badge,
    fallbackReason: inv && inv.engine === "deterministic-fallback" ? (inv.fallbackReason ?? null) : null,
    items,
    emptyText,
    progress,
    verdict,
    verdictEmpty:
      variant !== "takeover" && d.paymentShown === "settled"
        ? "No investigation. Low risk payments go through without one."
        : "The verdict appears when the investigation finishes.",
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function auditLine(e: AuditEntry, d: Derived): { text: string; source: AuditSource } | null {
  const data = e.data ?? {};
  const amount = typeof data.amount === "number" ? money(data.amount) : "";
  const engineSource: AuditSource = "agent";
  // The session is the attacker's only in the takeover scenario. In A and C it is the real customer.
  const sessionSource: AuditSource = d.variant === "takeover" ? "session" : "customer";
  switch (e.action) {
    case "LOGIN_SUCCEEDED":
      return { text: data.trusted
          ? "Login OK on trusted device"
          : d.variant === "takeover"
            ? "Login OK on unknown device"
            : "Login OK on new device", source: "auth" };
    case "SIM_SWAP_REPORTED":
      return { text: `Telco: SIM swapped at ${hm(typeof data.swappedAt === "string" ? data.swappedAt : "")}`, source: "telco" };
    case "BENEFICIARY_ADDED": {
      const ben = d.s.beneficiaries.find((b) => b.id === data.beneficiaryId);
      return { text: `Beneficiary added: ${ben?.name ?? "new payee"}`, source: sessionSource };
    }
    case "PAYMENT_REQUESTED":
      return { text: `Transfer requested: ${amount}`, source: sessionSource };
    case "PAYMENT_HELD":
      return { text: "Payment held before debit", source: "gateway" };
    case "PAYMENT_PENDING_VERIFICATION":
      return { text: "Payment waits for verification", source: "gateway" };
    case "PAYMENT_SETTLED":
      return { text: `Payment settled: ${amount}`, source: "gateway" };
    case "PAYMENT_REJECTED":
      return { text: "Transfer refused by the gateway", source: "gateway" };
    case "PAYMENT_CANCELLED":
      return { text: "Payment cancelled, nothing debited", source: "gateway" };
    case "PAYMENT_RELEASED":
      return { text: "Payment released by the customer", source: "verify" };
    case "SESSION_RESTRICTED": {
      const score = d.ctx.payment?.riskScore;
      return { text: score ? `Session restricted (risk ${score})` : "Session restricted", source: "gateway" };
    }
    case "SESSION_REVOKED":
      return { text: "Suspicious session revoked", source: "gateway" };
    case "SESSION_RESTRICTION_LIFTED":
      return { text: "Session restriction lifted", source: "verify" };
    case "INVESTIGATION_STARTED": {
      const inv = d.s.investigations.find((i) => i.id === data.investigationId);
      return { text: ENGINES[inv?.engine ?? "deterministic-fallback"].started, source: engineSource };
    }
    case "INVESTIGATION_COMPLETED": {
      const a = data.assessment as keyof typeof ASSESSMENT_TITLES | undefined;
      return { text: `Verdict: ${a && ASSESSMENT_TITLES[a] ? ASSESSMENT_TITLES[a].toLowerCase() : "ready"}`, source: engineSource };
    }
    case "INVESTIGATION_FAILED":
      return { text: "Investigation failed, protection stays", source: engineSource };
    case "INCIDENT_CREATED":
      return { text: `Incident ${String(data.incidentId ?? "")} opened`, source: e.actor === "ai-investigator" ? engineSource : "gateway" };
    case "INCIDENT_CONFIRMED_ATO":
      return { text: `${String(data.incidentId ?? "Incident")}: takeover confirmed`, source: "verify" };
    case "INCIDENT_RESOLVED_LEGITIMATE":
      return { text: `${String(data.incidentId ?? "Incident")}: resolved, legitimate`, source: "verify" };
    case "VERIFICATION_SENT":
      return { text: "Verification sent to trusted iPhone", source: "verify" };
    case "VERIFICATION_UNDELIVERABLE":
      return { text: "Verification undeliverable", source: "verify" };
    case "VERIFICATION_DENIED":
      return { text: "Customer: \"No, it wasn't me\"", source: "verify" };
    case "VERIFICATION_CONFIRMED":
      return { text: "Customer: \"Yes, it was me\"", source: "verify" };
    case "VERIFICATION_UNTRUSTED_RESPONSE":
      return { text: "Answer refused: untrusted channel", source: "verify" };
    case "HOLD_BYPASS_ATTEMPT": {
      const code = typeof data.code === "string" ? data.code : "";
      return {
        text: code === "SESSION_RESTRICTED" ? "Retry refused: session restricted" : `Retry refused: ${code.toLowerCase().replace(/_/g, " ")}`,
        source: "gateway",
      };
    }
    default:
      return null;
  }
}

/** Entries the presentation has not reached yet stay hidden in the compact log. */
function auditVisible(e: AuditEntry, d: Derived): boolean {
  const { r } = d;
  switch (e.action) {
    case "PAYMENT_HELD":
      return e.actor !== "payment-gateway" || r.hold !== "pending";
    case "SESSION_RESTRICTED":
      return e.actor === "payment-gateway" ? r.restrict !== "pending" : r.gate;
    case "PAYMENT_SETTLED":
      return d.paymentShown === "settled" || e.paymentId !== d.ctx.payment?.id;
    case "INCIDENT_CREATED":
      return d.incidentVisible || e.paymentId !== d.ctx.payment?.id;
    case "VERIFICATION_SENT":
    case "VERIFICATION_UNDELIVERABLE":
    case "INVESTIGATION_STARTED":
      return r.gate;
    case "INVESTIGATION_COMPLETED":
    case "INVESTIGATION_FAILED":
      return d.verdictShown;
    default:
      return true;
  }
}

const AUDIT_SOURCE_LABELS: Record<Exclude<AuditSource, "agent">, string> = {
  auth: "Auth",
  telco: "Telco",
  session: "Session",
  customer: "Customer",
  gateway: "Gateway",
  risk: "Risk engine",
  verify: "Verify",
};

function audit(d: Derived, engine: InvestigationEngine): View["audit"] {
  const rows: AuditRow[] = [];
  for (const e of d.s.audit) {
    const line = auditLine(e, d);
    if (!line || !auditVisible(e, d)) continue;
    rows.push({
      key: String(e.seq),
      time: hms(e.at),
      text: line.text,
      title: `${hms(e.at)} ${e.action}: ${e.detail}`,
      source: line.source,
      sourceLabel: line.source === "agent" ? ENGINES[engine].source : AUDIT_SOURCE_LABELS[line.source],
    });
  }
  return {
    recent: rows.slice(-10),
    all: d.s.audit.map((e) => ({
      seq: e.seq,
      time: hms(e.at),
      actor: e.actor === "customer" && d.variant !== "takeover" ? "Customer" : (ACTOR_LABELS[e.actor] ?? e.actor),
      action: e.action,
      detail: e.detail,
    })),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function toView(s: StateSnapshot, ui: UiState): View {
  const d = derive(s, ui);
  const inv = investigation(d);
  let moment: View["moment"] = null;
  if (ui.reveal.hold === "showing") {
    moment = {
      kind: "hold",
      title: "PAYMENT ON HOLD",
      sub: `${money(d.amount)} held before debit`,
      by: `Payment gateway, by code, at risk ${d.score}`,
    };
  } else if (ui.reveal.restrict === "showing") {
    moment = {
      kind: "restrict",
      title: "SESSION RESTRICTED",
      sub: "No more payments from this session",
      by: `Payment gateway, by code, at risk ${d.score}`,
    };
  }
  return {
    variant: d.variant,
    scenarioId: s.scenario?.id ?? null,
    band: d.band,
    moment,
    topbar: topbar(d),
    caption: caption(d),
    finale: finaleFor(d),
    customer: customer(d),
    side: side(d),
    risk: risk(d),
    actions: actions(d),
    investigation: inv,
    audit: audit(d, inv.engine),
  };
}
