"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BandRow, InvestigationView, Tile, View } from "@/lib/ui/view-model";
import { CheckCircle, ErrorCircle, ListIcon } from "./icons";
import { useTween } from "./motion";

// ---------------------------------------------------------------------------
// Caption and finale banner
// ---------------------------------------------------------------------------

function FinaleTitle({ title }: { title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.classList.remove("is-wrapped");
      const phrases = el.querySelectorAll<HTMLElement>(".finale-phrase");
      const wraps = phrases.length > 1 && phrases[phrases.length - 1].offsetTop > phrases[0].offsetTop + 2;
      setWrapped(wraps);
      if (wraps) el.classList.add("is-wrapped");
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [title]);
  const phrases = title.split(" • ");
  return (
    <div ref={ref} className={`finale-title${wrapped ? " is-wrapped" : ""}`} aria-label={title}>
      {phrases.map((p, i) => (
        <Fragment key={p}>
          {i > 0 && (
            <span className="finale-sep" aria-hidden="true">
              {"•"}
            </span>
          )}
          <span className="finale-phrase">{p}</span>
        </Fragment>
      ))}
    </div>
  );
}

function Caption({ caption, finale }: Pick<View, "caption" | "finale">) {
  return (
    <div className={`caption${finale ? ` is-finale is-finale--${finale.tone}` : ""}`} aria-live="polite">
      <div className="caption-body">
        <div className="caption-kicker" data-tone={caption.tone}>
          {caption.kicker}
        </div>
        <div className="caption-text">{caption.text}</div>
      </div>
      <div className="finale">
        {finale && (
          <>
            <FinaleTitle title={finale.title} />
            <div className="finale-line">{finale.line}</div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk engine
// ---------------------------------------------------------------------------

const BAND_COLORS: Record<BandRow["id"], string> = {
  low: "var(--band-low)",
  elevated: "var(--band-elevated)",
  high: "var(--band-high)",
  critical: "var(--band-critical)",
};

// 270 degree arc, band segments as background, value arc on top.
const CX = 100;
const CY = 100;
const R = 78;
function pt(deg: number): string {
  const a = (deg * Math.PI) / 180;
  return `${(CX + R * Math.cos(a)).toFixed(2)} ${(CY + R * Math.sin(a)).toFixed(2)}`;
}
const ARC = `M${pt(135)} A${R} ${R} 0 1 1 ${pt(45)}`;

function RiskDial({ score, bandLabel, bands }: { score: number; bandLabel: string; bands: BandRow[] }) {
  const shown = useTween(score);
  const [bumpKey, setBumpKey] = useState(0);
  const prev = useRef(score);
  useEffect(() => {
    const up = score > prev.current;
    prev.current = score;
    if (!up) return;
    const raf = requestAnimationFrame(() => setBumpKey((k) => k + 1));
    return () => cancelAnimationFrame(raf);
  }, [score]);
  return (
    <div className="risk-dial">
      <svg viewBox="0 0 200 180" aria-hidden="true">
        {bands.map((b) => {
          const len = (b.max === 100 ? 100 : b.max + 1) - b.min;
          return (
            <path
              key={b.id}
              className={`risk-dial-track${score >= b.min && score > 0 ? " is-reached" : ""}`}
              d={ARC}
              pathLength={100}
              stroke={BAND_COLORS[b.id]}
              strokeDasharray={`${len - 0.8} 200`}
              strokeDashoffset={-b.min}
            />
          );
        })}
        <path className="risk-dial-value" d={ARC} pathLength={100} strokeDasharray={`${Math.max(0.01, score)} 200`} />
      </svg>
      <div className="risk-dial-readout">
        <div key={bumpKey} className={`risk-score${bumpKey > 0 ? " is-bump" : ""}`}>
          {shown}
        </div>
        <div className="risk-score-of">risk score of 100</div>
        <div className="risk-band-name">{bandLabel}</div>
      </div>
    </div>
  );
}

function RiskPanel({ risk }: Pick<View, "risk">) {
  return (
    <section className="panel panel--risk" aria-label="Risk engine">
      <div className="panel-head">
        <h2 className="panel-title">Risk engine</h2>
        <span className="panel-meta">Deterministic rules, points per signal</span>
      </div>
      <div className="risk-gauge">
        <RiskDial score={risk.score} bandLabel={risk.bandLabel} bands={risk.bands} />
        <ol className="band-list">
          {risk.bands.map((b) => (
            <li key={b.id} className={`band-row${b.current ? " is-current" : ""}`} data-band={b.id}>
              <span className="band-range">
                {b.min}-{b.max}
              </span>
              <span className="band-name">{b.label}</span>
              <span className="band-action">{b.action}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="subhead">
        <span>Signals</span>
        <span className="subhead-meta">{risk.disclaimer}</span>
      </div>
      <ul className="signal-list">
        {risk.signals.map((sg) => (
          <li
            key={sg.id}
            className={`signal${sg.fired ? " is-fired is-new" : ""}`}
            data-band={sg.band}
            data-signal={sg.id}
            title={sg.title}
          >
            <span className="signal-name">{sg.label}</span>
            <span className="signal-detail">{sg.detail}</span>
            <span className="signal-points">+{sg.points}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Protective actions and investigation
// ---------------------------------------------------------------------------

function ActionTile({ label, tile }: { label: string; tile: Tile }) {
  // Re-keyed on change so the flash animation plays once per new state.
  return (
    <div key={`${tile.value}|${tile.sub}`} className={`action-tile${tile.tone ? ` is-${tile.tone} is-new` : ""}`}>
      <span className="action-label">{label}</span>
      <span className="action-value">{tile.value}</span>
      <span className="action-sub">{tile.sub}</span>
    </div>
  );
}

function ToolList({ inv }: { inv: InvestigationView }) {
  const ref = useRef<HTMLOListElement>(null);
  const count = inv.items.length;
  useLayoutEffect(() => {
    // Newest stays visible when the list overflows.
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <ol className="tool-list" ref={ref}>
      {inv.items.length === 0 && <li className="tool-empty">{inv.emptyText}</li>}
      {inv.items.map((item) =>
        item.kind === "note" ? (
          <li key={item.id} className="tool-note">
            {item.parts.map((part, i) =>
              "href" in part ? (
                <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
                  {part.href.replace(/^https?:\/\//, "")}
                </a>
              ) : (
                <Fragment key={i}>{part.text}</Fragment>
              ),
            )}
          </li>
        ) : (
          <li key={item.id} className={`tool-call is-${item.status === "ok" ? "done" : item.status}`}>
            <span className="tool-icon">
              {item.status === "running" ? <span className="spinner" /> : item.status === "error" ? <ErrorCircle /> : <CheckCircle />}
            </span>
            <span className="tool-name">{item.name}</span>
            <span className="tool-result">{item.result}</span>
          </li>
        ),
      )}
    </ol>
  );
}

function Verdict({ inv }: { inv: InvestigationView }) {
  const v = inv.verdict;
  return (
    <div className={`verdict${v ? " is-shown" : ""}${v?.failed ? " is-failed" : ""}${inv.progress ? " is-running" : ""}`}>
      {!v && !inv.progress && <div className="verdict-empty">{inv.verdictEmpty}</div>}
      {!v && inv.progress && (
        <div className="verdict-progress" role="status">
          <div className="verdict-progress-head">
            <span className="spinner" />
            <span className="verdict-progress-label">{inv.progress.label}</span>
            <span className="verdict-progress-time">{inv.progress.elapsed}</span>
          </div>
          <div className="verdict-progress-note">{inv.progress.note}</div>
        </div>
      )}
      {v && (
        <div className="verdict-content">
          <div className="verdict-head">
            <span className="verdict-title">{v.title}</span>
            <span className="verdict-by">{v.by}</span>
          </div>
          <p className="verdict-text" title={v.text}>
            {v.text}
          </p>
          {v.action && (
            <div className="verdict-action">
              <span className="verdict-action-label">Recommended</span>
              <span className="verdict-action-value">{v.action}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResponsePanel({ actions, investigation: inv }: Pick<View, "actions" | "investigation">) {
  return (
    <section className="panel panel--response" aria-label="Response">
      <div className="panel-head">
        <h2 className="panel-title">Protective actions</h2>
        <span className="panel-meta">Executed by the payment gateway, in code</span>
      </div>
      <div className="actions">
        <ActionTile label="Payment" tile={actions.payment} />
        <ActionTile label="Session" tile={actions.session} />
        <ActionTile label="Incident" tile={actions.incident} />
      </div>

      <div className="subhead subhead--agent">
        <span>Devin - AI investigation agent</span>
        <span className="subhead-meta">Recommends and explains, does not execute</span>
        <span className="engine-badge" data-engine={inv.engine}>
          {inv.badge}
        </span>
        {inv.fallbackReason && (
          <span className="engine-reason" title={inv.fallbackReason}>
            Fallback reason: {inv.fallbackReason}
          </span>
        )}
      </div>
      <ToolList inv={inv} />
      <Verdict inv={inv} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Audit log and moment stamp
// ---------------------------------------------------------------------------

function AuditPanel({ audit, onOpen }: { audit: View["audit"]; onOpen(): void }) {
  return (
    <section className="panel audit-log" aria-label="Audit log">
      <div className="panel-head">
        <h2 className="panel-title">Audit log</h2>
        <span className="panel-meta">
          Every event and action, in order
          <button type="button" className="audit-open" onClick={onOpen} title="Show every audit entry">
            <ListIcon />
            Full audit log ({audit.all.length})
          </button>
        </span>
      </div>
      <ol className="audit-list">
        {audit.recent.length === 0 && <li className="audit-empty">No events yet.</li>}
        {audit.recent.map((e) => (
          <li key={e.key} className="audit-entry" title={e.title}>
            <span className="audit-time">{e.time}</span>
            <span className="audit-text">{e.text}</span>
            <span className="audit-source" data-source={e.source}>
              {e.sourceLabel}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Moment({ moment }: Pick<View, "moment">) {
  // Keep the last content while fading out.
  const [last, setLast] = useState(moment);
  if (moment && moment !== last && (moment.kind !== last?.kind || moment.by !== last.by)) setLast(moment);
  const shown = moment ?? last;
  return (
    <div className={`moment${moment ? " is-shown" : ""}`} data-kind={shown?.kind} aria-live="assertive">
      <div className="moment-card">
        <div className="moment-title">{shown?.title}</div>
        <div className="moment-sub">{shown?.sub}</div>
        <div className="moment-by">{shown?.by}</div>
      </div>
    </div>
  );
}

export function DefenderColumn({ view, onOpenAudit }: { view: View; onOpenAudit(): void }) {
  return (
    <section className="column column--defender" aria-label="AI Defender">
      <Caption caption={view.caption} finale={view.finale} />
      <div className="defender-grid">
        <RiskPanel risk={view.risk} />
        <ResponsePanel actions={view.actions} investigation={view.investigation} />
      </div>
      <AuditPanel audit={view.audit} onOpen={onOpenAudit} />
      <Moment moment={view.moment} />
    </section>
  );
}
