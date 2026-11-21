"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import type { AuditFullRow } from "@/lib/ui/view-model";
import { CloseIcon } from "./icons";

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function AuditOverlay({ rows, onClose }: { rows: AuditFullRow[]; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The "Full audit log" button opened the overlay; it gets focus back on close.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
    // Focus that escapes anyway (a click outside the card, a screen reader jump) is pulled back.
    const onFocusIn = (e: FocusEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) closeRef.current?.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  // Tab and Shift+Tab cycle inside the card.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !cardRef.current) return;
    const items = Array.from(cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !cardRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !cardRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Full audit log" onClick={onClose} onKeyDown={onKeyDown}>
      <div className="overlay-card" ref={cardRef} onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <h2 className="panel-title">Full audit log</h2>
          <span className="panel-meta">
            {rows.length} entries, oldest first. Simulated time, Dubai. Esc closes.
          </span>
          <button ref={closeRef} type="button" className="ctrl" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="overlay-body" ref={bodyRef} tabIndex={0} role="region" aria-label="Audit entries">
          <table className="audit-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.seq}>
                  <td className="audit-table-seq">{r.seq}</td>
                  <td className="audit-table-time">{r.time}</td>
                  <td className="audit-table-actor">{r.actor}</td>
                  <td className="audit-table-action">{r.action}</td>
                  <td className="audit-table-detail">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
