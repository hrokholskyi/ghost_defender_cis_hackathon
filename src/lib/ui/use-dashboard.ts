"use client";

/**
 * The dashboard's only stateful piece: polls the backend, paces the reveal,
 * runs the presenter controls and the phone interactions, and hands a pure
 * View to the components.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScenarioId, StateSnapshot } from "@/lib/types";
import { acceptSnapshot } from "./accept-snapshot";
import { api, describeError } from "./api";
import { planReveal, syncReveal, type Reveal } from "./reveal";
import { runContext } from "./run-context";
import { toView, type PendingRequest, type UiState, type View } from "./view-model";

const POLL_MS = 500;
/** Autoplay: about this long between two events. */
const AUTOPLAY_GAP_MS = 3000;
/** Autoplay: pause after the previous event's animation finished. */
const AUTOPLAY_AFTER_IDLE_MS = 900;
const DEFAULT_SCENARIO: ScenarioId = "B";

interface RunLocal {
  reveal: Reveal | null;
  retry: UiState["retry"];
  verifyError: string | null;
}

export interface DashboardActions {
  start(id: ScenarioId): void;
  next(): void;
  restart(): void;
  toggleAutoplay(): void;
  verify(response: "CONFIRM" | "DENY"): void;
  retry(): void;
  openAudit(): void;
  closeAudit(): void;
}

export interface Dashboard {
  view: View | null;
  actions: DashboardActions;
  auditOpen: boolean;
  reachable: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function useDashboard(): Dashboard {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [local, setLocal] = useState<RunLocal>({ reveal: null, retry: { status: "idle" }, verifyError: null });
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [reachable, setReachable] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState(0);
  const [auditOpen, setAuditOpen] = useState(false);

  const snapshotRef = useRef<StateSnapshot | null>(null);
  const busyRef = useRef(false);
  const autoStarted = useRef<string | null>(null);

  // Keep the reveal in step with the snapshot's run (adjusting state while rendering).
  let current = local;
  if (snapshot) {
    const synced = syncReveal(local.reveal, snapshot);
    if (synced !== local.reveal) {
      const fresh = synced.runKey !== local.reveal?.runKey;
      current = {
        reveal: synced,
        retry: fresh ? { status: "idle" } : local.retry,
        verifyError: fresh ? null : local.verifyError,
      };
      setLocal(current);
    }
  }
  const reveal = current.reveal;

  const accept = useCallback((next: StateSnapshot | null | undefined) => {
    setSnapshot((prev) => (acceptSnapshot(prev, next) ? next : prev));
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const refresh = useCallback(async () => {
    const r = await api.state();
    if (r.ok) accept(r.data);
  }, [accept]);

  // Poll GET /api/state. Sequential, so requests never overlap; skipped while the tab is hidden.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        const r = await api.state();
        if (stopped) return;
        if (r.ok) {
          accept(r.data);
          setReachable(true);
        } else {
          setReachable(false);
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };
    const onVisible = () => {
      if (!document.hidden && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        void tick();
      }
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accept]);

  // Reveal pacing. The plan is serialised so a new poll with the same plan does not restart the timer.
  const plan = snapshot && reveal ? planReveal(snapshot, reveal) : null;
  const planKey = plan ? JSON.stringify(plan) : null;
  useEffect(() => {
    if (!planKey) return;
    const { delayMs, next } = JSON.parse(planKey) as { delayMs: number; next: Reveal };
    const timer = setTimeout(() => {
      setLocal((l) => (l.reveal?.runKey === next.runKey ? { ...l, reveal: next } : l));
    }, delayMs);
    return () => clearTimeout(timer);
  }, [planKey]);

  const start = useCallback(
    async (id: ScenarioId, keepAutoplay = false) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setPending("start");
      setActionError(null);
      if (!keepAutoplay) setAutoplay(false);
      const r = await api.startScenario(id);
      busyRef.current = false;
      setPending(null);
      if (r.ok) {
        accept(r.data);
        setLastEventAt(Date.now());
      } else {
        setActionError(describeError(r));
      }
    },
    [accept],
  );

  const next = useCallback(async () => {
    const s = snapshotRef.current;
    if (busyRef.current || !s?.scenario || s.scenario.nextStep >= s.scenario.totalSteps) return;
    busyRef.current = true;
    setPending("next");
    setActionError(null);
    const r = await api.nextStep();
    busyRef.current = false;
    setPending(null);
    if (r.ok) {
      accept(r.data.state);
      setLastEventAt(Date.now());
      if (r.data.scenario.nextStep >= r.data.scenario.totalSteps) setAutoplay(false);
    } else {
      setActionError(describeError(r));
      setAutoplay(false);
    }
  }, [accept]);

  const restart = useCallback(() => {
    void start(snapshotRef.current?.scenario?.id ?? DEFAULT_SCENARIO);
  }, [start]);

  const toggleAutoplay = useCallback(() => {
    const s = snapshotRef.current;
    const finished = !!s?.scenario && s.scenario.nextStep >= s.scenario.totalSteps;
    if (autoplay) {
      setAutoplay(false);
      return;
    }
    setAutoplay(true);
    if (finished || !s?.scenario) void start(s?.scenario?.id ?? DEFAULT_SCENARIO, true);
  }, [autoplay, start]);

  const verify = useCallback(
    async (response: "CONFIRM" | "DENY") => {
      const s = snapshotRef.current;
      if (!s || busyRef.current) return;
      const ctx = runContext(s);
      const verification = ctx.verification;
      const target = verification?.targetSessionId
        ? s.sessions.find((x) => x.id === verification.targetSessionId)
        : undefined;
      if (!verification || !target) {
        setLocal((l) => ({ ...l, verifyError: "No trusted session can answer this verification" }));
        return;
      }
      busyRef.current = true;
      setPending("verify");
      setLocal((l) => ({ ...l, verifyError: null }));
      const r = await api.respond(verification.id, response, target.token);
      busyRef.current = false;
      setPending(null);
      if (!r.ok) setLocal((l) => ({ ...l, verifyError: describeError(r) }));
      await refresh();
    },
    [refresh],
  );

  const retry = useCallback(async () => {
    const s = snapshotRef.current;
    if (!s || busyRef.current) return;
    const ctx = runContext(s);
    if (!ctx.payment || !ctx.actorSession) return;
    busyRef.current = true;
    setPending("retry");
    setLocal((l) => ({ ...l, retry: { status: "pending" } }));
    const r = await api.execute(ctx.payment.id, ctx.actorSession.token);
    busyRef.current = false;
    setPending(null);
    const sessionStatus = ctx.actorSession.status;
    setLocal((l) => ({
      ...l,
      retry: r.ok
        ? { status: "done", message: `Payment is ${r.data.payment.status}`, sessionStatus }
        : { status: "refused", message: r.status === 0 ? r.message : `Request refused: ${r.status} ${r.code}`, sessionStatus },
    }));
    await refresh();
  }, [refresh]);

  // First load from a server with no active scenario: start scenario B, so the calm pre-attack screen shows.
  useEffect(() => {
    if (!snapshot || snapshot.scenario || autoStarted.current === snapshot.serverId) return;
    autoStarted.current = snapshot.serverId;
    const timer = setTimeout(() => void start(DEFAULT_SCENARIO), 0);
    return () => clearTimeout(timer);
  }, [snapshot, start]);

  // Autoplay: next event about every 3 s, and never before the previous animation finished.
  const scenarioId = snapshot?.scenario?.id ?? null;
  const finished = !!snapshot?.scenario && snapshot.scenario.nextStep >= snapshot.scenario.totalSteps;
  const revealIdle = plan === null;
  useEffect(() => {
    if (!autoplay || pending !== null || finished || !revealIdle || !scenarioId) return;
    const wait = Math.max(AUTOPLAY_AFTER_IDLE_MS, AUTOPLAY_GAP_MS - (Date.now() - lastEventAt));
    const timer = setTimeout(() => void next(), wait);
    return () => clearTimeout(timer);
  }, [autoplay, pending, finished, revealIdle, scenarioId, lastEventAt, next]);

  // Presenter keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (auditOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setAuditOpen(false);
        }
        return;
      }
      if (e.key === "ArrowRight" || e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) void next();
      } else if (e.key === "p" || e.key === "P") {
        toggleAutoplay();
      } else if (e.key === "r" || e.key === "R") {
        restart();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [auditOpen, next, toggleAutoplay, restart]);

  const view = useMemo(() => {
    if (!snapshot || !reveal) return null;
    return toView(snapshot, {
      reveal,
      pending,
      autoplay,
      reachable,
      actionError,
      retry: current.retry,
      verifyError: current.verifyError,
    });
  }, [snapshot, reveal, pending, autoplay, reachable, actionError, current.retry, current.verifyError]);

  const actions = useMemo<DashboardActions>(
    () => ({
      start: (id) => void start(id),
      next: () => void next(),
      restart,
      toggleAutoplay,
      verify: (response) => void verify(response),
      retry: () => void retry(),
      openAudit: () => setAuditOpen(true),
      closeAudit: () => setAuditOpen(false),
    }),
    [start, next, restart, toggleAutoplay, verify, retry],
  );

  return { view, actions, auditOpen, reachable };
}
