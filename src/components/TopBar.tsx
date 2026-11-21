import { Fragment } from "react";
import type { ScenarioId } from "@/lib/types";
import type { TopBarView } from "@/lib/ui/view-model";
import { BrandMark, Chevron, NextIcon, PauseBars, PlayIcon, RestartIcon } from "./icons";

interface Props {
  view: TopBarView;
  onStart(id: ScenarioId): void;
  onNext(): void;
  onRestart(): void;
  onToggleAutoplay(): void;
}

export function TopBar({ view, onStart, onNext, onRestart, onToggleAutoplay }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Ghost Login Defender</span>
        <span className="brand-tags">
          <span className="sim-tag">SIMULATION - synthetic data</span>
          {!view.reachable ? (
            <span className="link-status is-down" role="status">
              Backend unreachable - showing last state
            </span>
          ) : view.error ? (
            <span className="link-status is-down" role="status" title={view.error}>
              {view.error}
            </span>
          ) : (
            <span className="engine-status" data-engine={view.investigatorEngine} title={view.investigator}>
              {view.investigator}
            </span>
          )}
        </span>
      </div>

      <ol className="event-chips" aria-label="Scenario events">
        {view.chips.map((chip, i) => (
          <Fragment key={chip.type}>
            {i > 0 && (
              <li aria-hidden="true">
                <Chevron />
              </li>
            )}
            <li
              className={`event-chip${chip.status === "active" ? " is-active" : ""}${chip.status === "done" ? " is-done" : ""}`}
              data-persona={chip.persona}
            >
              <span className="event-chip-dot" />
              {chip.type}
            </li>
          </Fragment>
        ))}
      </ol>

      <div className="sim-clock" aria-label="Simulated clock">
        <span className="sim-clock-label">Simulated time</span>
        <span className="sim-clock-time">
          {view.clock.hm}
          <small>:{view.clock.ss}</small>
        </span>
      </div>

      <div className="controls">
        <div className="scenario-switch" role="group" aria-label="Scenario">
          {view.scenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`scenario-btn${s.active ? " is-active" : ""}`}
              aria-pressed={s.active}
              title={`Scenario ${s.id}: ${s.title}`}
              disabled={view.busy}
              onClick={() => onStart(s.id)}
            >
              <span className="scenario-id">{s.id}</span>
              <span className="scenario-name">{s.title}</span>
            </button>
          ))}
        </div>
        <button
          className="ctrl ctrl--primary"
          type="button"
          title="Run the next event (Right arrow or Space)"
          aria-keyshortcuts="ArrowRight Space"
          disabled={view.nextDisabled}
          onClick={onNext}
        >
          <NextIcon />
          <span>{view.nextLabel}</span>
        </button>
        <button
          className={`ctrl${view.autoplay ? " is-on" : ""}`}
          type="button"
          title={view.autoplay ? "Stop autoplay (P)" : "Autoplay the remaining events (P)"}
          aria-label="Autoplay"
          aria-keyshortcuts="P"
          aria-pressed={view.autoplay}
          onClick={onToggleAutoplay}
        >
          {view.autoplay ? <PauseBars /> : <PlayIcon />}
        </button>
        <button
          className="ctrl"
          type="button"
          title="Restart the scenario (R)"
          aria-label="Restart"
          aria-keyshortcuts="R"
          disabled={view.busy}
          onClick={onRestart}
        >
          <RestartIcon />
        </button>
      </div>
    </header>
  );
}
