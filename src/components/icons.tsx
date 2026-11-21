/** Inline SVG icons from the demo. All decorative (aria-hidden). */
import type { PresenceIcon } from "@/lib/ui/view-model";

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16 2.5 4.5 7v8.2c0 7 4.9 12.6 11.5 14.3 6.6-1.7 11.5-7.3 11.5-14.3V7L16 2.5Z"
        fill="none"
        stroke="#eef3fb"
        strokeWidth="2"
      />
      <path
        d="M10.5 22.5v-8.2a5.5 5.5 0 0 1 11 0v8.2l-1.8-1.4-1.9 1.4-1.8-1.4-1.8 1.4-1.9-1.4-1.8 1.4Z"
        fill="#34d896"
      />
      <circle cx="14" cy="14.6" r="1.2" fill="#0b1628" />
      <circle cx="18" cy="14.6" r="1.2" fill="#0b1628" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg className="event-sep" viewBox="0 0 12 12" aria-hidden="true">
      <path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckCircle() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m4.8 8.2 2.2 2.2 4.2-4.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckFilled() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="m4.6 8.3 2.3 2.2 4.5-4.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Tick() {
  return (
    <svg className="field-tick" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ErrorCircle() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5v4.2M8 11.2v.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Pause() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z" fill="currentColor" />
      <path d="M6.3 5v6M9.7 5v6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function Shield({ fill = "#fff" }: { fill?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 2.5 3.8v4c0 3.3 2.3 6 5.5 6.8 3.2-.8 5.5-3.5 5.5-6.8v-4L8 1.5Z" fill={fill} />
    </svg>
  );
}

export function Padlock({ fill = "currentColor" }: { fill?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" fill={fill} />
      <path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke={fill} strokeWidth="1.6" />
    </svg>
  );
}

export function PresenceGlyph({ icon }: { icon: PresenceIcon }) {
  switch (icon) {
    case "moon":
      return (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M7.6 1A5 5 0 1 0 11 8.4 4.2 4.2 0 0 1 7.6 1Z" fill="currentColor" />
        </svg>
      );
    case "bell":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 1.8a4.2 4.2 0 0 0-4.2 4.2v3L2.5 11.5h11L12.2 9V6A4.2 4.2 0 0 0 8 1.8ZM6.3 13a1.8 1.8 0 0 0 3.4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "lock":
      return <Padlock />;
    case "check":
      return <CheckCircle />;
    default:
      return (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="3.5" fill="currentColor" />
        </svg>
      );
  }
}

export function Wifi() {
  return (
    <svg viewBox="0 0 18 12" aria-hidden="true">
      <path
        d="M9 11.2 6.6 8.6a3.4 3.4 0 0 1 4.8 0L9 11.2Zm-4-4.3L3.4 5.2a8 8 0 0 1 11.2 0L13 6.9a5.7 5.7 0 0 0-8 0Zm-2.9-3L.5 2.2a12 12 0 0 1 17 0L15.9 3.9a9.8 9.8 0 0 0-13.8 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function IosBattery() {
  return (
    <svg viewBox="0 0 26 12" aria-hidden="true">
      <rect x=".6" y=".6" width="22" height="10.8" rx="3" fill="none" stroke="currentColor" strokeOpacity=".5" strokeWidth="1.2" />
      <rect x="2.4" y="2.4" width="13" height="7.2" rx="1.6" fill="currentColor" />
      <path d="M24 4v4c.9-.3 1.4-1.1 1.4-2s-.5-1.7-1.4-2Z" fill="currentColor" fillOpacity=".5" />
    </svg>
  );
}

export function SignalBars() {
  return (
    <svg viewBox="0 0 16 12" aria-hidden="true">
      <path d="M1 11h2V8H1v3Zm4 0h2V6H5v5Zm4 0h2V3H9v8Zm4 0h2V0h-2v11Z" fill="currentColor" />
    </svg>
  );
}

export function AndroidBattery() {
  return (
    <svg viewBox="0 0 24 12" aria-hidden="true">
      <rect x=".6" y=".6" width="20" height="10.8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2.4" y="2.4" width="9" height="7.2" rx="1" fill="currentColor" />
      <rect x="21.6" y="4" width="1.8" height="4" rx=".6" fill="currentColor" />
    </svg>
  );
}

export function TransferGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PayeeGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6" cy="5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M1.5 14c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4M12.5 5v5M10 7.5h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Torch() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 1.5h5l-1 4v8.5h-3V5.5l-1-4Z" fill="#fff" />
    </svg>
  );
}

export function Camera() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 5h2.5l1.2-2h4.6l1.2 2H14v8H2V5Z" fill="none" stroke="#fff" strokeWidth="1.4" />
      <circle cx="8" cy="9" r="2.3" fill="none" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.5v11l9-5.5-9-5.5Z" fill="currentColor" />
    </svg>
  );
}

export function PauseBars() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3" height="11" fill="currentColor" />
      <rect x="9.5" y="2.5" width="3" height="11" fill="currentColor" />
    </svg>
  );
}

export function NextIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 2.5v11l7-5.5-7-5.5Z" fill="currentColor" />
      <rect x="11" y="2.5" width="2" height="11" fill="currentColor" />
    </svg>
  );
}

export function RestartIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3 1.8v3.4h3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="2.6" cy="4" r="1" fill="currentColor" />
      <circle cx="2.6" cy="8" r="1" fill="currentColor" />
      <circle cx="2.6" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
