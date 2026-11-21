"use client";

import { useDashboard } from "@/lib/ui/use-dashboard";
import { AuditOverlay } from "./AuditOverlay";
import { CustomerColumn, SideColumn } from "./Columns";
import { DefenderColumn } from "./Defender";
import { BrandMark } from "./icons";
import { TopBar } from "./TopBar";

export function Dashboard() {
  const { view, actions, auditOpen, reachable } = useDashboard();

  if (!view) {
    return (
      <div className="app app--loading" data-band="low">
        <div className="loading">
          <BrandMark />
          <span className="brand-name">Ghost Login Defender</span>
          <span className={`loading-text${reachable ? "" : " is-down"}`} role="status">
            {reachable ? "Connecting to the simulator..." : "Backend unreachable. Retrying..."}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-band={view.band} data-moment={view.moment?.kind ?? ""} data-variant={view.variant}>
      <TopBar
        view={view.topbar}
        onStart={actions.start}
        onNext={actions.next}
        onRestart={actions.restart}
        onToggleAutoplay={actions.toggleAutoplay}
      />
      <main className="stage-grid">
        <CustomerColumn view={view.customer} onVerify={actions.verify} />
        <DefenderColumn view={view} onOpenAudit={actions.openAudit} />
        <SideColumn view={view.side} onRetry={actions.retry} />
      </main>
      {auditOpen && <AuditOverlay rows={view.audit.all} onClose={actions.closeAudit} />}
    </div>
  );
}
