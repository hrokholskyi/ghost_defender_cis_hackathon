import { beforeEach, describe, expect, it } from "vitest";
import { addBeneficiary, login } from "@/lib/bank";
import { DomainError } from "@/lib/errors";
import { whenIdle } from "@/lib/investigations";
import { RISK_THRESHOLDS } from "@/lib/config";
import { crossingRecord, executePayment, requestTransfer } from "@/lib/payment-gateway";
import { firstCrossing } from "@/lib/risk-engine";
import { nextScenarioStep, startScenario } from "@/lib/scenarios";
import { getSnapshot } from "@/lib/snapshot";
import { SEED_BENEFICIARY_IDS } from "@/lib/store";
import type { RiskAssessment, RiskSignalId, ToolName } from "@/lib/types";
import { attackerSession, auditActions, freshStore, iphoneSession, runScenario } from "./helpers";

beforeEach(freshStore);

function expectDomainError(fn: () => unknown, code: string): DomainError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error(`Expected DomainError ${code}`);
}

describe("seed data", () => {
  it("has the fictional customer, one trusted device and a 3000 AED median", () => {
    const s = getSnapshot();
    expect(s.customer).toMatchObject({ id: "cust-001", name: "Layla Hassan", homeCountry: "AE", balance: 92000 });
    expect(s.devices).toHaveLength(1);
    expect(s.devices[0]).toMatchObject({ id: "dev-iphone", label: "iPhone 15 Pro", trusted: true });
    expect(s.beneficiaries).toHaveLength(3);
    for (const b of s.beneficiaries) expect(b.settledPaymentCount).toBeGreaterThan(0);
    const history = s.payments.filter((p) => p.historical);
    expect(history).toHaveLength(8);
    expect(history.every((p) => p.status === "SETTLED")).toBe(true);
    expect(s.sim.swapConfirmed).toBe(false);
    expect(s.now).toMatch(/\+04:00$/);
  });
});

describe("scenario A - normal customer", () => {
  it("settles the payment at risk 0", async () => {
    const s = runScenario("A");
    const payment = s.payments.find((p) => !p.historical);
    expect(payment?.status).toBe("SETTLED");
    expect(payment?.riskScore).toBe(0);
    expect(s.risk[payment!.sessionId].score).toBe(0);
    expect(s.customer.balance).toBe(89000);
    expect(s.investigations).toHaveLength(0);
    await whenIdle();
    expect(getSnapshot().incidents).toHaveLength(0);
  });
});

describe("scenario B - account takeover", () => {
  it("holds the transfer before debit, step by step", async () => {
    startScenario("B");
    const scores: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { state } = nextScenarioStep();
      scores.push(state.risk[state.scenario!.actorSessionId!].score);
    }
    expect(scores).toEqual([15, 40, 55, 90]);

    const s = getSnapshot();
    const attacker = attackerSession(s);
    const risk = s.risk[attacker.id];
    expect(risk.level).toBe("CRITICAL");
    expect(risk.action).toBe("HOLD_AND_RESTRICT");
    expect(risk.signals.map((x) => [x.id, x.cumulative])).toEqual([
      ["UNKNOWN_DEVICE", 15],
      ["RECENT_SIM_SWAP", 40],
      ["NEW_BENEFICIARY", 55],
      ["UNUSUAL_AMOUNT", 75],
      ["RAPID_SEQUENCE", 90],
    ]);
    expect(risk.signals[0].detectedAt).toBe("2026-03-15T02:00:00+04:00");
    expect(risk.signals[1].detectedAt).toBe("2026-03-15T02:01:00+04:00");

    const payment = s.payments.find((p) => p.sessionId === attacker.id)!;
    expect(payment.status).toBe("HELD");
    expect(payment.amount).toBe(85000);
    expect(payment.settledAt).toBeUndefined();
    expect(s.customer.balance).toBe(92000);
    expect(attacker.status).toBe("RESTRICTED");
    expect(attacker.restrictionReason).toBeTruthy();

    const iphone = iphoneSession(s);
    expect(iphone.status).toBe("ACTIVE");
    expect(s.risk[iphone.id].score).toBe(0);

    const verification = s.verifications.find((v) => v.paymentId === payment.id)!;
    expect(verification).toMatchObject({
      status: "PENDING",
      channel: "TRUSTED_DEVICE_PUSH",
      targetSessionId: iphone.id,
      targetDeviceId: "dev-iphone",
      suspiciousSessionId: attacker.id,
    });

    await whenIdle();
    const after = getSnapshot();
    const inv = after.investigations.find((i) => i.paymentId === payment.id)!;
    expect(inv.status).toBe("COMPLETED");
    expect(inv.verdict).toBeDefined();
    const tools = new Set(inv.steps.filter((x) => x.kind === "tool_call").map((x) => (x as { tool: ToolName }).tool));
    expect([...tools].sort()).toEqual(
      [
        "check_beneficiary",
        "create_incident",
        "get_device_history",
        "get_payment_history",
        "get_session_activity",
        "get_sim_status",
      ].sort(),
    );
    expect(inv.steps.every((x) => x.kind !== "tool_call" || x.status === "ok")).toBe(true);

    const incident = after.incidents.find((i) => i.paymentId === payment.id);
    expect(incident?.status).toBe("OPEN");
    expect(incident?.id).toBe("INC-0001");
    expect(after.payments.find((p) => p.id === payment.id)?.status).toBe("HELD");
    expect(after.payments.some((p) => p.id === payment.id && p.status === "SETTLED")).toBe(false);
    expect(after.customer.balance).toBe(92000);

    const actions = auditActions(after);
    for (const action of [
      "LOGIN_SUCCEEDED",
      "SIM_SWAP_REPORTED",
      "RISK_ASSESSED",
      "BENEFICIARY_ADDED",
      "PAYMENT_REQUESTED",
      "PAYMENT_HELD",
      "SESSION_RESTRICTED",
      "VERIFICATION_SENT",
      "INVESTIGATION_STARTED",
      "INVESTIGATION_COMPLETED",
      "INCIDENT_CREATED",
    ]) {
      expect(actions).toContain(action);
    }
    expect(actions).not.toContain("PAYMENT_SETTLED");
    const assessed = after.audit.filter((e) => e.action === "RISK_ASSESSED" && e.sessionId === attacker.id);
    expect(assessed.map((e) => e.data?.score)).toEqual([15, 40, 55, 90]);
  });

  it("refuses retries and new transfers from the restricted session", () => {
    const s = runScenario("B");
    const attacker = attackerSession(s);
    const held = s.payments.find((p) => p.sessionId === attacker.id)!;

    expectDomainError(() => executePayment(attacker.token, held.id), "SESSION_RESTRICTED");
    const afterRetry = getSnapshot();
    expect(afterRetry.payments.find((p) => p.id === held.id)?.status).toBe("HELD");
    expect(afterRetry.customer.balance).toBe(92000);
    expect(auditActions(afterRetry)).toContain("HOLD_BYPASS_ATTEMPT");

    const err = expectDomainError(
      () => requestTransfer(attacker.token, { beneficiaryId: held.beneficiaryId, amount: 1000 }),
      "SESSION_RESTRICTED",
    );
    expect(err.status).toBe(403);
    const after = getSnapshot();
    const rejected = after.payments.filter((p) => p.sessionId === attacker.id && p.status === "REJECTED");
    expect(rejected).toHaveLength(1);
    expect(after.customer.balance).toBe(92000);
    expect(auditActions(after)).toContain("PAYMENT_REJECTED");
  });

  it("returns PAYMENT_HELD on retry of a held payment from an active session", () => {
    // HIGH, not CRITICAL: new device + SIM swap + unusual amount to a known beneficiary = 60 -> HOLD only.
    startScenario("B");
    nextScenarioStep(); // login
    nextScenarioStep(); // SIM swap
    const attacker = attackerSession(getSnapshot());
    const { payment, risk } = requestTransfer(attacker.token, {
      beneficiaryId: SEED_BENEFICIARY_IDS.alNoor,
      amount: 20000,
    });
    expect(risk.score).toBe(60);
    expect(payment.status).toBe("HELD");
    expect(getSnapshot().sessions.find((x) => x.id === attacker.id)?.status).toBe("ACTIVE");

    const err = expectDomainError(() => executePayment(attacker.token, payment.id), "PAYMENT_HELD");
    expect(err.status).toBe(409);
    const s = getSnapshot();
    expect(s.payments.find((p) => p.id === payment.id)?.status).toBe("HELD");
    expect(s.customer.balance).toBe(92000);
    expect(s.audit.filter((e) => e.action === "HOLD_BYPASS_ATTEMPT")).toHaveLength(1);
  });

  it("lets the trusted iPhone pay a known beneficiary during the incident", async () => {
    const s = runScenario("B");
    await whenIdle();
    expect(getSnapshot().incidents).toHaveLength(1);
    const iphone = iphoneSession(s);
    const { payment, risk, balance } = requestTransfer(iphone.token, {
      beneficiaryId: SEED_BENEFICIARY_IDS.dewa,
      amount: 3000,
    });
    expect(risk.score).toBe(0);
    expect(payment.status).toBe("SETTLED");
    expect(balance).toBe(89000);
  });

  it("never debits a settled payment twice on retry", () => {
    const s = runScenario("A");
    const payment = s.payments.find((p) => !p.historical)!;
    const session = s.sessions.find((x) => x.id === payment.sessionId)!;
    const again = executePayment(session.token, payment.id);
    expect(again.payment.status).toBe("SETTLED");
    expect(again.balance).toBe(89000);
    expect(getSnapshot().customer.balance).toBe(89000);
  });

  it("refuses next when the scenario finished or none is active", () => {
    expectDomainError(() => nextScenarioStep(), "CONFLICT");
    runScenario("A");
    expectDomainError(() => nextScenarioStep(), "CONFLICT");
  });
});

describe("scenario C - legitimate phone change", () => {
  it("settles at risk 15 and keeps the session active", async () => {
    const s = runScenario("C");
    const session = s.sessions.find((x) => x.id === s.scenario!.actorSessionId)!;
    const payment = s.payments.find((p) => p.sessionId === session.id)!;
    expect(s.risk[session.id].score).toBe(15);
    expect(s.risk[session.id].level).toBe("LOW");
    expect(s.risk[session.id].signals.map((x) => x.id)).toEqual(["UNKNOWN_DEVICE"]);
    expect(payment.status).toBe("SETTLED");
    expect(payment.amount).toBe(3200);
    expect(session.status).toBe("ACTIVE");
    expect(s.customer.balance).toBe(92000 - 3200);
    await whenIdle();
    expect(getSnapshot().incidents).toHaveLength(0);
    expect(getSnapshot().investigations).toHaveLength(0);
  });
});

describe("elevated risk - step-up", () => {
  it("puts the payment in PENDING_VERIFICATION without debit or restriction", async () => {
    const { session } = login({
      deviceId: "dev-tablet",
      device: { label: "Galaxy Tab S9", platform: "Android" },
      network: { ip: "10.1.1.1", city: "Dubai", country: "AE" },
      at: "2026-03-15T11:00:00+04:00",
    });
    const { beneficiary, risk: afterAdd } = addBeneficiary(session.token, {
      name: "Gulf Tutors LLC",
      iban: "AE00 DEMO 5555 0000 0000 123",
      at: "2026-03-15T11:02:00+04:00",
    });
    expect(afterAdd.score).toBe(30);
    // Outside the 10-minute window, normal amount: stays ELEVATED.
    const { payment, risk, balance } = requestTransfer(session.token, {
      beneficiaryId: beneficiary.id,
      amount: 2000,
      at: "2026-03-15T11:20:00+04:00",
    });
    expect(risk.score).toBe(30);
    expect(risk.level).toBe("ELEVATED");
    expect(risk.action).toBe("STEP_UP");
    expect(payment.status).toBe("PENDING_VERIFICATION");
    expect(balance).toBe(92000);

    const s = getSnapshot();
    expect(s.sessions.find((x) => x.id === session.id)?.status).toBe("ACTIVE");
    // No trusted active session exists, so the push cannot be delivered and the payment stays pending.
    expect(s.verifications.find((v) => v.paymentId === payment.id)?.status).toBe("UNDELIVERABLE");

    await whenIdle();
    const after = getSnapshot();
    expect(after.payments.find((p) => p.id === payment.id)?.status).toBe("PENDING_VERIFICATION");
    expect(after.sessions.find((x) => x.id === session.id)?.status).toBe("ACTIVE");
    expect(after.customer.balance).toBe(92000);
    expect(after.investigations.find((i) => i.paymentId === payment.id)?.status).toBe("COMPLETED");
  });
});

describe("SIM swap re-assessment", () => {
  it("raises an active session's risk when the signal arrives after login", () => {
    startScenario("B");
    nextScenarioStep();
    const attacker = attackerSession(getSnapshot());
    expect(getSnapshot().risk[attacker.id].score).toBe(15);
    nextScenarioStep();
    expect(getSnapshot().risk[attacker.id].score).toBe(40);
  });
});

describe("backend wording", () => {
  it("scenario B audit and messages use plain, honest text", async () => {
    const s = runScenario("B");
    const attacker = attackerSession(s);
    const payment = s.payments.find((p) => p.sessionId === attacker.id)!;
    await whenIdle();
    const after = getSnapshot();
    const detail = (action: string) => after.audit.find((e) => e.action === action && (e.sessionId === attacker.id || !e.sessionId))?.detail;

    expect(detail("LOGIN_SUCCEEDED")).toMatch(/^Login accepted \(simulated: password and SMS code assumed correct\)\. Device .+ \(Android, not in device history\), network /);
    expect(detail("SIM_SWAP_REPORTED")).toBe("Synthetic telco signal: SIM swapped at 01:15, phone number +971 •• ••• 4821");

    const incident = after.incidents.find((i) => i.paymentId === payment.id)!;
    expect(incident.title).toBe("Suspected account takeover");
    const verdict = after.investigations.find((i) => i.paymentId === payment.id)!.verdict!;
    expect(verdict.summary).toContain("This session matches the demo account takeover pattern (risk score 90, Critical).");
    expect(after.riskConfig.disclaimer).toBe("Demo weights and thresholds. Synthetic scores and amounts. Not a calibrated model.");

    const transfer = expectDomainError(
      () => requestTransfer(attacker.token, { beneficiaryId: payment.beneficiaryId, amount: 500 }),
      "SESSION_RESTRICTED",
    );
    expect(transfer.message).toBe("Transfer refused: this session is restricted.");
    const rejected = getSnapshot().audit.filter((e) => e.action === "PAYMENT_REJECTED").at(-1)!;
    expect(rejected.detail).toBe("Transfer of AED 500 refused: this session is restricted.");
    expect(rejected.data).toMatchObject({ code: "SESSION_RESTRICTED", sessionId: attacker.id, sessionStatus: "RESTRICTED" });

    const retry = expectDomainError(() => executePayment(attacker.token, payment.id), "SESSION_RESTRICTED");
    expect(retry.message).toBe("Retry refused: this session is restricted.");
    for (const text of getSnapshot().audit.map((e) => e.detail)) expect(text).not.toMatch(/[–—]/);
  });
});

describe("staged hold in the gateway's own record", () => {
  it("scenario B: the hold names 75 (High, Unusual amount), the restriction 90 (Critical, Rapid sequence)", async () => {
    const s = runScenario("B");
    const attacker = attackerSession(s);
    const payment = s.payments.find((p) => p.sessionId === attacker.id)!;
    await whenIdle();
    const after = getSnapshot();

    const held = after.audit.find((e) => e.action === "PAYMENT_HELD" && e.paymentId === payment.id)!;
    expect(held.actor).toBe("payment-gateway");
    expect(held.detail).toBe(
      "Payment of AED 85,000 held before debit. Running score reached 75 (High) with signal Unusual amount.",
    );
    expect(held.data).toMatchObject({ score: 75, level: "HIGH", signal: "UNUSUAL_AMOUNT", amount: 85000 });

    const restricted = after.audit.find((e) => e.action === "SESSION_RESTRICTED" && e.sessionId === attacker.id)!;
    expect(restricted.actor).toBe("payment-gateway");
    expect(restricted.detail).toContain("Session restricted. Running score reached 90 (Critical) with signal Rapid sequence.");
    expect(restricted.data).toEqual({ score: 90, level: "CRITICAL", signal: "RAPID_SEQUENCE" });

    const reasons = after.payments.find((p) => p.id === payment.id)!.reasons;
    expect(reasons).toContain("Held by payment-gateway: Running score reached 75 (High) with signal Unusual amount.");
    expect(reasons).toContain("Session restricted by payment-gateway: Running score reached 90 (Critical) with signal Rapid sequence.");

    // The decision itself is unchanged: one assessment, HOLD_AND_RESTRICT at 90.
    expect(payment).toMatchObject({ status: "HELD", riskScore: 90, riskLevel: "CRITICAL", action: "HOLD_AND_RESTRICT" });
    expect(after.sessions.find((x) => x.id === attacker.id)?.status).toBe("RESTRICTED");
  });

  it("one signal that crosses both thresholds triggers both the hold and the restriction", () => {
    const at = "2026-03-15T02:03:00+04:00";
    const risk: RiskAssessment = {
      sessionId: "sess-x",
      score: 85,
      level: "CRITICAL",
      action: "HOLD_AND_RESTRICT",
      assessedAt: at,
      signals: [
        { id: "UNKNOWN_DEVICE", label: "Unknown device", points: 15, evidence: "e", cumulative: 15, detectedAt: at },
        { id: "NEW_BENEFICIARY", label: "New beneficiary", points: 15, evidence: "e", cumulative: 30, detectedAt: at },
        { id: "UNUSUAL_AMOUNT", label: "Unusual amount", points: 55, evidence: "e", cumulative: 85, detectedAt: at },
      ],
    };
    expect(firstCrossing(risk, RISK_THRESHOLDS.high)).toEqual({
      score: 85,
      level: "CRITICAL",
      signal: "UNUSUAL_AMOUNT",
      signalLabel: "Unusual amount",
    });
    expect(crossingRecord(risk, RISK_THRESHOLDS.high).text).toBe("Running score reached 85 (Critical) with signal Unusual amount.");
    expect(crossingRecord(risk, RISK_THRESHOLDS.critical)).toEqual({
      text: "Running score reached 85 (Critical) with signal Unusual amount.",
      data: { score: 85, level: "CRITICAL", signal: "UNUSUAL_AMOUNT" },
    });
  });

  it("walks the signals in canonical order even if they are listed out of order", () => {
    const at = "2026-03-15T02:03:00+04:00";
    const sig = (id: RiskSignalId, cumulative: number) => ({ id, label: id, points: 0, evidence: "e", cumulative, detectedAt: at });
    const crossing = firstCrossing({ signals: [sig("RAPID_SEQUENCE", 90), sig("UNKNOWN_DEVICE", 15), sig("UNUSUAL_AMOUNT", 75)] }, 60);
    expect(crossing?.signal).toBe("UNUSUAL_AMOUNT");
    expect(firstCrossing({ signals: [sig("UNKNOWN_DEVICE", 15)] }, 60)).toBeNull();
  });
});
