/**
 * Investigation tools, bound to one session and one payment. The investigator
 * cannot query other sessions or customers. Read tools compute their results
 * from the store; create_incident is idempotent per payment.
 */
import { findBeneficiary, findDevice, requirePayment, requireSession } from "@/lib/bank";
import { maskIban } from "@/lib/format";
import { openIncident } from "@/lib/incidents";
import { median } from "@/lib/risk-engine";
import { getState } from "@/lib/store";
import { minutesBetween } from "@/lib/time";
import type {
  BeneficiaryCheckResult,
  DeviceHistoryResult,
  InvestigationTools,
  PaymentHistoryResult,
  RiskLevel,
  SessionActivityResult,
  SimStatusResult,
} from "@/lib/types";

const RISK_LEVELS: readonly RiskLevel[] = ["LOW", "ELEVATED", "HIGH", "CRITICAL"];

/** Thrown when the store was reset while an investigation was still running. */
export class StaleInvestigationError extends Error {
  constructor() {
    super("The simulator was reset while this investigation was running");
    this.name = "StaleInvestigationError";
  }
}

export function buildInvestigationTools(sessionId: string, paymentId: string, epoch: number): InvestigationTools {
  function guard(): void {
    if (getState().epoch !== epoch) throw new StaleInvestigationError();
  }

  function deviceHistory(): DeviceHistoryResult {
    const session = requireSession(sessionId);
    const device = findDevice(session.deviceId);
    const meta = getState().sessionMeta[sessionId];
    return {
      currentDevice: {
        id: session.deviceId,
        label: device?.label ?? session.deviceId,
        platform: device?.platform ?? "Android",
        known: meta?.deviceTrustedAtLogin ?? device?.trusted ?? false,
        firstSeenAt: device?.firstSeenAt ?? null,
      },
      knownDevices: getState()
        .devices.filter((d) => d.trusted)
        .map((d) => ({ id: d.id, label: d.label, platform: d.platform, lastSeenAt: d.lastSeenAt })),
    };
  }

  function simStatus(): SimStatusResult {
    const session = requireSession(sessionId);
    const { sim } = getState();
    return {
      available: true,
      source: sim.source,
      swapConfirmed: sim.swapConfirmed,
      swappedAt: sim.swappedAt,
      minutesBeforeLogin:
        sim.swapConfirmed && sim.swappedAt ? minutesBetween(sim.swappedAt, session.createdAt) : null,
    };
  }

  function sessionActivity(): SessionActivityResult {
    const session = requireSession(sessionId);
    const payment = requirePayment(paymentId);
    const events = getState()
      .audit.filter((e) => e.sessionId === sessionId)
      .map((e) => ({ at: e.at, type: e.action, detail: e.detail }));
    return {
      sessionId,
      loginAt: session.createdAt,
      network: { ...session.network },
      events,
      minutesFromLoginToTransfer: minutesBetween(session.createdAt, payment.requestedAt),
    };
  }

  function paymentHistory(): PaymentHistoryResult {
    const payment = requirePayment(paymentId);
    const settled = getState()
      .payments.filter((p) => p.status === "SETTLED" && p.id !== paymentId)
      .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
    const amounts = settled.map((p) => p.amount);
    const typical = median(amounts);
    return {
      settledCount: settled.length,
      typicalAmount: typical,
      maxAmount: amounts.length ? Math.max(...amounts) : 0,
      currency: "AED",
      recent: settled.slice(0, 5).map((p) => ({
        amount: p.amount,
        beneficiaryName: findBeneficiary(p.beneficiaryId)?.name ?? p.beneficiaryId,
        settledAt: p.settledAt ?? p.decidedAt,
      })),
      currentAmount: payment.amount,
      ratioToTypical: typical > 0 ? Math.round((payment.amount / typical) * 10) / 10 : 0,
    };
  }

  function beneficiaryCheck(): BeneficiaryCheckResult {
    const payment = requirePayment(paymentId);
    const beneficiary = findBeneficiary(payment.beneficiaryId);
    if (!beneficiary) throw new Error(`Beneficiary ${payment.beneficiaryId} not found`);
    // Count only payments settled before this one, so a later release does not rewrite history.
    const prior = getState().payments.filter(
      (p) => p.beneficiaryId === beneficiary.id && p.status === "SETTLED" && p.id !== paymentId,
    ).length;
    return {
      beneficiaryId: beneficiary.id,
      name: beneficiary.name,
      ibanMasked: maskIban(beneficiary.iban),
      knownBefore: prior > 0,
      priorSettledPayments: prior,
      addedAt: beneficiary.createdAt,
      addedInThisSession: beneficiary.createdBySessionId === sessionId,
    };
  }

  return {
    async get_device_history() {
      guard();
      return deviceHistory();
    },
    async get_sim_status() {
      guard();
      return simStatus();
    },
    async get_session_activity() {
      guard();
      return sessionActivity();
    },
    async get_payment_history() {
      guard();
      return paymentHistory();
    },
    async check_beneficiary() {
      guard();
      return beneficiaryCheck();
    },
    async create_incident(input) {
      guard();
      // The input may come from a model: keep only well-formed values.
      const payment = requirePayment(paymentId);
      const severity = RISK_LEVELS.includes(input?.severity) ? input.severity : payment.riskLevel;
      const title =
        typeof input?.title === "string" && input.title.trim() ? input.title.trim().slice(0, 160) : "Suspicious payment";
      const reasons = Array.isArray(input?.reasons)
        ? input.reasons.filter((r): r is string => typeof r === "string").slice(0, 20)
        : [];
      return structuredClone(openIncident("ai-investigator", sessionId, paymentId, { title, severity, reasons }));
    },
  };
}
