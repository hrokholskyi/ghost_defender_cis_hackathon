"use client";

import { useEffect, useRef } from "react";
import type { AuditFullRow } from "@/lib/ui/view-model";
import { CloseIcon } from "./icons";

export function AuditOverlay({ rows, onClose }: { rows: AuditFullRow[]; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, []);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Full audit log" onClick={onClose}>
      <div className="overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <h2 className="panel-title">Full audit log</h2>
          <span className="panel-meta">
            {rows.length} entries, oldest first. Simulated time, Dubai. Esc closes.
          </span>
          <button ref={closeRef} type="button" className="ctrl" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="overlay-body" ref={bodyRef}>
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
