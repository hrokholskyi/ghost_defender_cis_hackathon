/**
 * Pure decisions behind the presenter controls, so a nervous presenter
 * cannot skip a story, wipe the finale or flood the backend.
 */
import type { TopBarView } from "./view-model";

export interface NextGate {
  /** A request (start, next, verify, retry) is in flight. */
  busy: boolean;
  /** The staged reveal of the last event has caught up with the snapshot. */
  revealIdle: boolean;
  hasScenario: boolean;
  finished: boolean;
}

/** May the next scenario event fire now? Never while the previous one is still playing. */
export function canFireNext(g: NextGate): boolean {
  return !g.busy && g.revealIdle && g.hasScenario && !g.finished;
}

export type AutoplayToggle = "stop" | "start" | "start-scenario" | "ignore";

/** What a P press does. At the finale it does nothing: only R restarts. */
export function autoplayToggle(s: { autoplay: boolean; hasScenario: boolean; finished: boolean }): AutoplayToggle {
  if (s.autoplay) return "stop";
  if (!s.hasScenario) return "start-scenario";
  if (s.finished) return "ignore";
  return "start";
}

export function autoplayTitle(s: { autoplay: boolean; finished: boolean }): string {
  if (s.autoplay) return "Stop autoplay (P)";
  if (s.finished) return "Scenario finished - press R to restart it";
  return "Autoplay the remaining events (P)";
}

export const AUTOPLAY_CHARS_PER_SECOND = 15;
export const AUTOPLAY_MIN_PAUSE_MS = 3000;

/** Autoplay pause after the reveal finished, long enough to read the caption on screen. */
export function autoplayPauseMs(caption: string): number {
  const readMs = Math.ceil((caption.trim().length / AUTOPLAY_CHARS_PER_SECOND) * 1000);
  return Math.max(AUTOPLAY_MIN_PAUSE_MS, readMs);
}

export type PresenterKeyAction = "next" | "autoplay" | "restart" | "close-audit";

export interface PresenterKey {
  key: string;
  code: string;
  repeat: boolean;
  modified: boolean;
  typing: boolean;
  auditOpen: boolean;
}

export interface PresenterKeyResult {
  action: PresenterKeyAction | null;
  preventDefault: boolean;
}

const NONE: PresenterKeyResult = { action: null, preventDefault: false };

/**
 * Maps a keydown to a presenter action. Held keys (`repeat`) never act, but
 * a held Space or Right arrow still has its default (page scroll) blocked.
 */
export function presenterKey(e: PresenterKey): PresenterKeyResult {
  if (e.modified || e.typing) return NONE;
  let action: PresenterKeyAction | null = null;
  if (e.auditOpen) {
    if (e.key === "Escape") action = "close-audit";
  } else if (e.key === "ArrowRight" || e.code === "Space") {
    action = "next";
  } else if (e.key === "p" || e.key === "P") {
    action = "autoplay";
  } else if (e.key === "r" || e.key === "R") {
    action = "restart";
  }
  if (!action) return NONE;
  return { action: e.repeat ? null : action, preventDefault: true };
}

/** The top bar as the presenter controls see it. */
export interface PresenterTopBarView extends TopBarView {
  /** The last event's reveal is still playing, so Next waits. */
  revealing: boolean;
}
