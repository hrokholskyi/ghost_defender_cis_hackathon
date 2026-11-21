import { beforeEach, describe, expect, it } from "vitest";
import { freshStore } from "@/lib/__tests__/helpers";
import { whenIdle } from "@/lib/investigations";
import { executePayment } from "@/lib/payment-gateway";
import { nextScenarioStep, startScenario } from "@/lib/scenarios";
import { getSnapshot } from "@/lib/snapshot";
import type { ScenarioId, StateSnapshot } from "@/lib/types";
import { respondToVerification } from "@/lib/verification";
import { linkify } from "../format";
import { emptyReveal, fullReveal, planReveal, revealedScore, syncReveal, type Reveal } from "../reveal";
import { runContext, runKey } from "../run-context";
import { fallbackReasonText, retryRefusalText, toView, type UiState, type View } from "../view-model";

beforeEach(freshStore);

function ui(reveal: Reveal, extra: Partial<UiState> = {}): UiState {
  return {
    reveal,
    pending: null,
    autoplay: false,
    reachable: true,
    actionError: null,
    retry: { status: "idle" },
    verifyError: null,
    ...extra,
  };
}

/** View of a snapshot with everything already revealed. */
function settledView(s: StateSnapshot, extra: Partial<UiState> = {}): View {
  return toView(s, ui(fullReveal(s), extra));
}

/** Plays the reveal sequence to the end and records each intermediate view. */
function play(s: StateSnapshot, from: Reveal): { reveal: Reveal; views: View[] } {
  let reveal = syncReveal(from, s);
  const views: View[] = [toView(s, ui(reveal))];
  for (let i = 0; i < 100; i++) {
    const plan = planReveal(s, reveal);
    if (!plan) break;
    reveal = plan.next;
    views.push(toView(s, ui(reveal)));
  }
  return { reveal, views };
}

function noEmDash(view: View): void {
  expect(JSON.stringify(view)).not.toMatch(/[—–]/);
}

async function runToEnd(id: ScenarioId): Promise<StateSnapshot> {
  startScenario(id);
  for (let s = getSnapshot(); s.scenario && s.scenario.nextStep < s.scenario.totalSteps; s = getSnapshot()) {
    nextScenarioStep();
  }
  await whenIdle();
  return getSnapshot();
}

describe("idle", () => {
  it("shows the calm pre-attack screen of scenario B", () => {
    const s = startScenario("B");
    const view = toView(s, ui(syncReveal(null, s)));
    expect(view.variant).toBe("takeover");
    expect(view.caption.kicker).toBe("Before the attack");
    expect(view.caption.text).toContain("Layla is asleep");
    expect(view.topbar.nextLabel).toBe("Next: LOGIN");
    expect(view.topbar.nextDisabled).toBe(false);
    expect(view.topbar.chips.map((c) => c.status)).toEqual(["idle", "idle", "idle", "idle"]);
    expect(view.topbar.investigator).toBe("Investigator: deterministic fallback");
    expect(view.risk.score).toBe(0);
    expect(view.risk.signals).toHaveLength(6);
    expect(view.risk.signals.every((x) => !x.fired)).toBe(true);
    expect(view.risk.disclaimer).toBe(s.riskConfig.disclaimer);
    expect(view.actions.payment).toMatchObject({ value: "None", sub: "No payment yet" });
    expect(view.customer.presence.label).toBe("Asleep");
    expect(view.customer.phone.widget).toMatchObject({ balance: 92000, status: "No recent activity" });
    expect(view.customer.phone.lockTime).toBe("1:59");
    expect(view.side.kind).toBe("attacker");
    expect(view.side.phone?.app.screen).toBe("login");
    expect(view.finale).toBeNull();
    expect(view.moment).toBeNull();
    noEmDash(view);
  });

  it("starts empty for a fresh run and catches up on first load", () => {
    const s = startScenario("B");
    expect(syncReveal(null, s).runKey).toBe(runKey(s));
    const old = emptyReveal("old-run");
    expect(syncReveal(old, s)).toEqual(emptyReveal(runKey(s)));
    nextScenarioStep();
    const later = getSnapshot();
    // A reload in the middle of a run shows the current state at once.
    expect(syncReveal(null, later).signals).toEqual(["UNKNOWN_DEVICE"]);
    expect(planReveal(later, syncReveal(null, later))).toBeNull();
  });
});

describe("scenario B, step by step", () => {
  it("LOGIN: login form first, then the unknown device signal at 15", () => {
    const start = startScenario("B");
    let reveal = syncReveal(null, start);
    nextScenarioStep();
    const s = getSnapshot();
    reveal = syncReveal(reveal, s);
    const arrival = toView(s, ui(reveal));
    expect(arrival.caption.kicker).toBe("Step 1 of 4 - LOGIN");
    expect(arrival.side.phone?.app.screen).toBe("login");
    expect(arrival.side.phone?.app.login.success).toBe(true);
    expect(arrival.risk.score).toBe(0);
    expect(arrival.topbar.chips[0].status).toBe("active");
    expect(arrival.topbar.nextLabel).toBe("Next: SIM_SWAP");

    const { views } = play(s, reveal);
    const end = views[views.length - 1];
    expect(end.risk.score).toBe(15);
    expect(end.risk.band).toBe("low");
    expect(end.caption.kicker).toBe("Risk 15 - Low - Monitor");
    expect(end.risk.signals[0]).toMatchObject({ fired: true, band: "low" });
    expect(end.risk.signals[0].detail).toContain("Samsung Galaxy A54");
    expect(end.side.phone?.app.screen).toBe("home");
    expect(end.side.presence.label).toBe("Logged in");
    expect(end.actions.session).toMatchObject({ value: "Active", sub: "Monitored" });
    expect(end.audit.recent.map((r) => r.text)).toContain("Login OK on unknown device");
  });

  it("SIM_SWAP and ADD_BENEFICIARY: 40 then 55", () => {
    startScenario("B");
    nextScenarioStep();
    let s = getSnapshot();
    let reveal = fullReveal(s);

    nextScenarioStep();
    s = getSnapshot();
    const simArrival = toView(s, ui(syncReveal(reveal, s)));
    expect(simArrival.caption.kicker).toBe("Step 2 of 4 - SIM_SWAP");
    expect(simArrival.caption.text).toBe("A synthetic telco signal arrives for Layla's phone number.");
    expect(simArrival.risk.signals.find((x) => x.id === "RECENT_SIM_SWAP")?.detail).toBe(
      "Synthetic telco signal: new SIM on this number",
    );
    let played = play(s, reveal);
    let end = played.views[played.views.length - 1];
    expect(end.risk.score).toBe(40);
    expect(end.caption.kicker).toBe("Risk 40 - Elevated - Extra verification");
    expect(end.caption.text).toBe("The SIM was swapped 45 minutes before login. The SMS code no longer proves it is Layla.");
    expect(end.customer.phone.serviceAlert).toBe(true);
    expect(end.side.phone?.app.simFlag).toBe(true);
    expect(end.audit.recent.map((r) => r.text)).toContain("Telco (synthetic): SIM swapped at 01:15");
    reveal = played.reveal;

    nextScenarioStep();
    s = getSnapshot();
    const arrival = toView(s, ui(syncReveal(reveal, s)));
    expect(arrival.caption.text).toBe("The session adds a new beneficiary: Orion Trading FZE.");
    expect(arrival.side.phone?.app.screen).toBe("beneficiary");
    expect(arrival.side.phone?.app.beneficiary.added).toBe(false);
    played = play(s, reveal);
    end = played.views[played.views.length - 1];
    expect(end.risk.score).toBe(55);
    expect(end.side.phone?.app.beneficiary.added).toBe(true);
    expect(end.caption.text).toBe("Unknown device, new SIM, new beneficiary. Any payment now needs extra checks.");
  });

  it("TRANSFER: 55 -> 75 -> HOLD -> 90 -> RESTRICTED -> investigation", async () => {
    startScenario("B");
    for (let i = 0; i < 3; i++) nextScenarioStep();
    const before = fullReveal(getSnapshot());
    nextScenarioStep();
    await whenIdle();
    const s = getSnapshot();
    expect(runContext(s).assessment?.score).toBe(90);

    const { views } = play(s, before);
    const arrival = views[0];
    expect(arrival.risk.score).toBe(55);
    expect(arrival.caption.text).toBe("The attacker requests AED 85,000 to Orion Trading FZE.");
    expect(arrival.actions.payment).toMatchObject({ tone: "warn", value: "AED 85,000", sub: "Requested" });
    expect(arrival.actions.session.value).toBe("Active");
    expect(arrival.side.phone?.app.transfer.status).toBe("sending");
    expect(arrival.investigation.items).toHaveLength(0);
    expect(arrival.audit.recent.map((r) => r.text)).not.toContain("Payment held before debit");

    // The gauge passes through 75 before 90, and the stamps come in order.
    const scores = views.map((v) => v.risk.score).filter((x, i, a) => a[i - 1] !== x);
    expect(scores).toEqual([55, 75, 90]);
    const moments = views.map((v) => v.moment?.kind ?? null).filter((x, i, a) => x && a[i - 1] !== x);
    expect(moments).toEqual(["hold", "restrict"]);

    const hold = views.find((v) => v.moment?.kind === "hold")!;
    expect(hold.risk.score).toBe(75);
    expect(hold.band).toBe("high");
    expect(hold.moment).toMatchObject({ title: "PAYMENT ON HOLD", sub: "AED 85,000 held before debit", by: "Payment gateway, by code, at risk 75" });
    expect(hold.actions.payment).toMatchObject({ tone: "held", value: "On hold" });
    expect(hold.actions.session.value).toBe("Active");
    expect(hold.caption.text).toBe("The amount is 28 times her typical transfer. Risk crosses 60.");
    expect(hold.investigation.items).toHaveLength(0);

    const restrict = views.find((v) => v.moment?.kind === "restrict")!;
    expect(restrict.risk.score).toBe(90);
    expect(restrict.band).toBe("critical");
    expect(restrict.actions.session).toMatchObject({ tone: "restricted", value: "Restricted" });
    expect(restrict.side.phone?.app.lockout?.title).toBe("Session restricted");
    expect(restrict.caption.text).toBe("Login, new beneficiary and a large transfer in 3 minutes. Risk crosses 80.");
    expect(restrict.investigation.items).toHaveLength(0);
    expect(restrict.customer.phone.push).toBeNull();

    // Tool calls appear one by one only after the stamps.
    const counts = views.map((v) => v.investigation.items.length);
    const firstTool = counts.findIndex((n) => n > 0);
    expect(firstTool).toBeGreaterThan(views.indexOf(restrict));
    expect(counts.slice(firstTool).every((n, i, a) => i === 0 || n >= a[i - 1])).toBe(true);

    const end = views[views.length - 1];
    const tools = end.investigation.items.filter((x) => x.kind === "tool");
    expect(tools.map((x) => x.kind === "tool" && x.name)).toEqual([
      "get_device_history()",
      "get_sim_status()",
      "get_session_activity()",
      "get_payment_history()",
      "check_beneficiary()",
      "create_incident()",
    ]);
    const results = tools.map((x) => (x.kind === "tool" ? x.result : ""));
    expect(results[0]).toBe("Samsung Galaxy A54: unknown device. iPhone 15 Pro: trusted.");
    expect(results[1]).toBe("SIM swap confirmed 45 min before login (synthetic signal).");
    expect(results[2]).toBe("Login -> new beneficiary -> transfer within 3 minutes.");
    expect(results[3]).toBe("Typical transfer about AED 3,000; this one is AED 85,000.");
    expect(results[4]).toBe("Orion Trading FZE: never paid before, added in this session.");
    expect(results[5]).toMatch(/^INC-\d{4} opened\.$/);

    expect(end.actions.incident).toMatchObject({ tone: "open", sub: "Open" });
    expect(end.investigation.verdict).toMatchObject({ title: "Likely account takeover", action: "Hold payment + restrict session", by: "Fallback verdict" });
    expect(end.customer.phone.push).toMatchObject({ state: "pending", title: "Did you request AED 85,000 to Orion Trading FZE?" });
    expect(end.customer.presence.label).toBe("Notified");
    expect(end.customer.phone.widget).toMatchObject({ balance: 92000, status: "Unchanged - nothing debited", protected: true });
    expect(end.finale).toMatchObject({ tone: "protected", title: "ACCOUNT TAKEOVER CONTAINED • AED 85,000 PROTECTED (SIMULATION)" });
    expect(end.finale?.line).toBe(
      "Password correct. SMS code correct. Login successful. The defender spotted a stranger's session and held the transfer before any debit. A verified login is not proof of safety.",
    );
    expect(end.risk.bands.map((b) => b.action)).toEqual([
      "Monitor",
      "Extra verification",
      "Hold payment + incident",
      "Hold payment + restrict session + incident",
    ]);
    expect(end.topbar.chips.every((c) => c.status === "done")).toBe(true);
    expect(end.topbar.nextDisabled).toBe(true);
    expect(end.topbar.nextLabel).toBe("Finished");
    expect(end.audit.recent).toHaveLength(10);
    expect(end.audit.recent.map((r) => r.text)).toEqual(
      expect.arrayContaining(["Payment held before debit", "Session restricted (risk 90)", "Verification sent to trusted iPhone"]),
    );
    expect(end.audit.all.length).toBe(s.audit.length);
    for (const v of views) noEmDash(v);
  });
});

describe("investigation engine display", () => {
  it("shows the fallback badge and its reason", async () => {
    const s = await runToEnd("B");
    const view = settledView(s);
    expect(view.investigation.engine).toBe("deterministic-fallback");
    expect(view.investigation.badge).toBe("Deterministic fallback - no LLM");
    expect(view.investigation.title).toBe("Investigation agent (deterministic fallback, no LLM)");
    expect(view.investigation.fallbackReason).toBeTruthy();
    expect(view.investigation.fallbackReasonText).toBe(fallbackReasonText(view.investigation.fallbackReason!));
    expect(view.caption.text).toBe("The investigation explains the decision.");
    expect(view.audit.recent.find((r) => r.source === "agent")?.sourceLabel).toBe("Fallback");
  });

  it("shows a running Devin investigation with elapsed time and linked notes", async () => {
    const s = structuredClone(await runToEnd("B"));
    const inv = s.investigations[0];
    inv.engine = "devin";
    inv.status = "RUNNING";
    delete inv.verdict;
    delete inv.fallbackReason;
    inv.startedAt = "2026-03-15T02:03:00+04:00";
    s.now = "2026-03-15T02:04:25+04:00";
    inv.steps = [
      { kind: "note", id: "n1", text: "Devin session started: https://app.devin.ai/sessions/abc123.", startedAt: inv.startedAt },
      ...inv.steps.filter((x) => x.kind === "tool_call").slice(0, 2),
      { kind: "tool_call", id: "t3", tool: "get_session_activity", input: {}, status: "running", startedAt: inv.startedAt },
    ];
    const view = settledView(s);
    expect(view.investigation.badge).toBe("Devin session");
    expect(view.investigation.title).toBe("AI investigation agent (Devin)");
    expect(view.caption.text).toBe("The investigation collects evidence with tools. Nothing has been debited.");
    expect(view.investigation.fallbackReason).toBeNull();
    expect(view.investigation.progress).toEqual({
      label: "Devin is investigating",
      elapsed: "1:25",
      note: "Protection did not wait: payment held and session restricted by code.",
    });
    expect(view.investigation.verdict).toBeNull();
    expect(view.actions.payment.value).toBe("On hold");
    expect(view.actions.session.value).toBe("Restricted");
    expect(view.finale).toBeNull();
    expect(view.caption).toMatchObject({ kicker: "Devin investigation", tone: "ai" });
    const note = view.investigation.items[0];
    expect(note.kind).toBe("note");
    if (note.kind === "note") {
      expect(note.parts).toEqual([
        { text: "Devin session started: " },
        { href: "https://app.devin.ai/sessions/abc123" },
        { text: "." },
      ]);
    }
    const running = view.investigation.items[3];
    expect(running).toMatchObject({ kind: "tool", status: "running", result: "running..." });
  });

  it("uses the title of the configured engine when no investigation ran", async () => {
    const s = structuredClone(await runToEnd("A"));
    expect(settledView(s).investigation.title).toBe("Investigation agent (deterministic fallback, no LLM)");
    s.llm.configured = true;
    expect(settledView(s).investigation.title).toBe("AI investigation agent (Devin)");
  });

  it("shortens a not-configured fallback reason and keeps the full reason for the tooltip", async () => {
    const reason = "Devin not configured: set DEVIN_API_KEY, DEVIN_ORG_ID and GLD_PUBLIC_URL";
    expect(fallbackReasonText(reason)).toBe("Devin is not configured for this run.");
    expect(fallbackReasonText("Investigator error: boom")).toBe("Investigator error: boom");
    const s = structuredClone(await runToEnd("B"));
    s.investigations[0].fallbackReason = reason;
    const view = settledView(s);
    expect(view.investigation.fallbackReason).toBe(reason);
    expect(view.investigation.fallbackReasonText).toBe("Devin is not configured for this run.");
  });

  it("linkify keeps plain text without URLs intact", () => {
    expect(linkify("No link here")).toEqual([{ text: "No link here" }]);
  });
});

describe("customer answers on the trusted iPhone", () => {
  it("DENY cancels, revokes and confirms the takeover; the banner stays", async () => {
    const s0 = await runToEnd("B");
    const ctx = runContext(s0);
    const target = s0.sessions.find((x) => x.id === ctx.verification?.targetSessionId)!;
    respondToVerification(target.token, ctx.verification!.id, { response: "DENY" });
    const s = getSnapshot();
    const reveal = fullReveal(s0);
    const view = toView(s, ui(syncReveal(reveal, s)));
    expect(view.actions.payment).toMatchObject({ value: "Cancelled", sub: "Nothing debited" });
    expect(view.actions.session).toMatchObject({ value: "Revoked" });
    expect(view.actions.incident.sub).toBe("Confirmed takeover");
    expect(view.side.phone?.app.lockout).toMatchObject({ kind: "revoked", title: "Session ended" });
    expect(view.side.presence.label).toBe("Signed out");
    expect(view.customer.phone.push?.state).toBe("denied");
    expect(view.customer.phone.widget).toMatchObject({ balance: 92000, protected: true });
    expect(view.finale?.tone).toBe("protected");
    expect(view.audit.recent.map((r) => r.text)).toContain("Customer: \"No, it wasn't me\"");
    noEmDash(view);
  });

  it("CONFIRM settles, drops the balance to 7,000 and replaces the banner", async () => {
    const s0 = await runToEnd("B");
    const ctx = runContext(s0);
    const target = s0.sessions.find((x) => x.id === ctx.verification?.targetSessionId)!;
    respondToVerification(target.token, ctx.verification!.id, { response: "CONFIRM" });
    await whenIdle();
    const s = getSnapshot();
    const view = toView(s, ui(syncReveal(fullReveal(s0), s)));
    expect(view.actions.payment).toMatchObject({ value: "Settled", sub: "Released by the customer" });
    expect(view.actions.incident.sub).toBe("Resolved - legitimate");
    expect(view.customer.phone.widget.balance).toBe(7000);
    expect(view.customer.phone.push?.state).toBe("confirmed");
    expect(view.finale).toMatchObject({ tone: "neutral", line: "Customer confirmed on the trusted device. Payment released." });
    expect(view.actions.session.sub).toBe("Restriction lifted");
  });

  it("shows the refused retry and its audit entry", async () => {
    const s0 = await runToEnd("B");
    const attacker = runContext(s0).actorSession!;
    expect(() => executePayment(attacker.token, runContext(s0).payment!.id)).toThrow();
    const s = getSnapshot();
    const view = toView(
      s,
      ui(fullReveal(s), {
        retry: { status: "refused", message: retryRefusalText("SESSION_RESTRICTED", "Session is restricted"), code: "403 SESSION_RESTRICTED" },
      }),
    );
    expect(view.side.phone?.app.lockout?.retry).toEqual({
      pressed: true,
      busy: false,
      refused: "Refused. Session restricted.",
      refusedCode: "403 SESSION_RESTRICTED",
    });
    expect(view.audit.recent[view.audit.recent.length - 1].text).toBe("Retry refused: session restricted");
  });

  it("builds the retry refusal text from the error code", () => {
    expect(retryRefusalText("SESSION_RESTRICTED", "Session sess-002 is restricted")).toBe("Refused. Session restricted.");
    expect(retryRefusalText("SESSION_REVOKED", "Session sess-002 is revoked")).toBe("Refused. Session revoked.");
    expect(retryRefusalText("PAYMENT_HELD", "Payment pay-001 is held")).toBe("Refused. Payment is on hold.");
    expect(retryRefusalText("INSUFFICIENT_FUNDS", "Insufficient funds")).toBe("Refused. Insufficient funds.");
    expect(retryRefusalText("CONFLICT", "Payment already settled.")).toBe("Refused. Payment already settled.");
    expect(retryRefusalText("HTTP_ERROR", "")).toBe("Refused.");
  });

  it("shows a verification error inline", async () => {
    const s = await runToEnd("B");
    const view = settledView(s, { verifyError: "422 INSUFFICIENT_FUNDS: Insufficient funds" });
    expect(view.customer.phone.push?.error).toBe("422 INSUFFICIENT_FUNDS: Insufficient funds");
  });
});

describe("scenario A, normal customer", () => {
  it("ends settled at risk 0 with a calm right column", async () => {
    const s = await runToEnd("A");
    const view = settledView(s);
    expect(view.variant).toBe("normal");
    expect(view.topbar.chips.map((c) => c.type)).toEqual(["LOGIN", "TRANSFER"]);
    expect(view.topbar.chips.every((c) => c.persona === "customer" && c.status === "done")).toBe(true);
    expect(view.risk.score).toBe(0);
    expect(view.actions.payment).toMatchObject({ tone: "safe", value: "Settled" });
    expect(view.actions.incident.sub).toBe("Not needed");
    expect(view.customer.phone.mode).toBe("app");
    expect(view.customer.phone.app?.transfer.status).toBe("settled");
    expect(view.customer.phone.app?.balance).toBe(89000);
    expect(view.side.kind).toBe("empty");
    expect(view.side.empty?.title).toBe("No other session");
    expect(view.finale).toMatchObject({ tone: "protected", line: "Legitimate payment approved. No friction for the real customer." });
    expect(view.investigation.items).toHaveLength(0);
    expect(view.investigation.emptyText).toContain("Not needed");
    expect(view.audit.recent.map((r) => r.text)).toContain("Payment settled: AED 3,000");
    noEmDash(view);
  });

  it("does not show the debit before the transfer beat", () => {
    startScenario("A");
    nextScenarioStep();
    const reveal = fullReveal(getSnapshot());
    nextScenarioStep();
    const s = getSnapshot();
    const arrival = toView(s, ui(syncReveal(reveal, s)));
    expect(arrival.actions.payment.sub).toBe("Requested");
    expect(arrival.customer.phone.app?.balance).toBe(92000);
    expect(arrival.finale).toBeNull();
    expect(revealedScore(s, reveal)).toBe(0);
  });
});

describe("scenario C, legitimate phone change", () => {
  it("ends settled at risk 15 with the new iPhone on the right", async () => {
    const s = await runToEnd("C");
    const view = settledView(s);
    expect(view.variant).toBe("newDevice");
    expect(view.risk.score).toBe(15);
    expect(view.risk.signals.filter((x) => x.fired).map((x) => x.id)).toEqual(["UNKNOWN_DEVICE"]);
    expect(view.side).toMatchObject({ kind: "newDevice", role: "New device", title: "iPhone 16" });
    expect(view.side.phone?.platform).toBe("iphone");
    expect(view.side.phone?.app.transfer.status).toBe("settled");
    expect(view.side.presence.label).toBe("Monitored");
    expect(view.actions.session).toMatchObject({ value: "Active", sub: "Monitored" });
    expect(view.actions.payment.value).toBe("Settled");
    expect(view.customer.phone.widget.balance).toBe(88800);
    expect(view.finale).toMatchObject({
      tone: "calm",
      title: "LEGITIMATE PHONE CHANGE • AED 3,200 SETTLED (SIMULATION)",
      line: "New device alone is not proof of fraud. Payment approved, session monitored.",
    });
    noEmDash(view);
  });
});

describe("engine badge and audit actor tags by scenario", () => {
  it("marks the investigation active only when one ran", async () => {
    for (const id of ["A", "C"] as const) {
      const view = settledView(await runToEnd(id));
      expect(view.investigation.active).toBe(false);
    }
    const b = settledView(await runToEnd("B"));
    expect(b.investigation.active).toBe(true);
    expect(b.investigation.fallbackReason).toBeTruthy();
  });

  it("tags the customer's own transfer as Customer in A and C and as Session in B", async () => {
    for (const id of ["A", "C"] as const) {
      const view = settledView(await runToEnd(id));
      const row = view.audit.recent.find((r) => r.text.startsWith("Transfer requested"));
      expect(row).toMatchObject({ source: "customer", sourceLabel: "Customer" });
      const full = view.audit.all.filter((r) => r.action === "PAYMENT_REQUESTED");
      expect(full.length).toBeGreaterThan(0);
      for (const r of full) expect(r.actor).toBe("Customer");
    }
    const b = settledView(await runToEnd("B"));
    const row = b.audit.recent.find((r) => r.text.startsWith("Transfer requested"));
    expect(row).toMatchObject({ source: "session", sourceLabel: "Session" });
    expect(b.audit.all.find((r) => r.action === "PAYMENT_REQUESTED")?.actor).toBe("Logged-in session");
  });
});
