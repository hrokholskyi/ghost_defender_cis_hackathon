import type { CustomerView, Note, Presence, SideView } from "@/lib/ui/view-model";
import { PresenceGlyph } from "./icons";
import { Android, AppIPhone, IPhone } from "./Phones";

function PresencePill({ presence }: { presence: Presence }) {
  return (
    <span className={`presence${presence.tone ? ` is-${presence.tone}` : ""}`}>
      <PresenceGlyph icon={presence.icon} />
      <span>{presence.label}</span>
    </span>
  );
}

function ColumnNote({ note }: { note: Note }) {
  const tone = note.tone === "key" ? " is-key" : note.tone === "hostile" ? " is-hostile" : "";
  return <p className={`column-note${tone}`}>{note.text}</p>;
}

function ColumnHead({ role, title, sub, presence }: { role: string; title: string; sub: string; presence: Presence }) {
  return (
    <div className="column-head">
      <div className="column-role">{role}</div>
      <div className="column-title">{title}</div>
      <PresencePill presence={presence} />
      <div className="column-sub">{sub}</div>
    </div>
  );
}

interface CustomerProps {
  view: CustomerView;
  onVerify(response: "CONFIRM" | "DENY"): void;
}

export function CustomerColumn({ view, onVerify }: CustomerProps) {
  return (
    <section className="column column--customer" aria-label="Real customer">
      <ColumnHead role={view.role} title={view.name} sub={view.sub} presence={view.presence} />
      <IPhone phone={view.phone} onVerify={onVerify} />
      <ColumnNote note={view.note} />
    </section>
  );
}

export function SideColumn({ view, onRetry }: { view: SideView; onRetry(): void }) {
  return (
    <section className={`column column--attacker column--${view.kind}`} aria-label={view.role}>
      <ColumnHead role={view.role} title={view.title} sub={view.sub} presence={view.presence} />
      {view.phone?.platform === "android" && <Android app={view.phone.app} time={view.phone.time} onRetry={onRetry} />}
      {view.phone?.platform === "iphone" && <AppIPhone app={view.phone.app} time={view.phone.time} />}
      {view.empty && (
        <div className="phone phone--empty">
          <div className="empty-session">
            <span className="empty-session-icon">
              <PresenceGlyph icon="check" />
            </span>
            <div className="empty-session-title">{view.empty.title}</div>
            <div className="empty-session-text">{view.empty.text}</div>
          </div>
        </div>
      )}
      <ColumnNote note={view.note} />
    </section>
  );
}
