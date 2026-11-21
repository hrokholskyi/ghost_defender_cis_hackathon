import type { ReactNode } from "react";
import type { AppView, CustomerView, PushView } from "@/lib/ui/view-model";
import {
  AndroidBattery,
  Camera,
  CheckCircle,
  CheckFilled,
  ErrorCircle,
  IosBattery,
  Padlock,
  PayeeGlyph,
  Pause,
  Shield,
  SignalBars,
  Tick,
  Torch,
  TransferGlyph,
  Wifi,
} from "./icons";
import { Money } from "./motion";

// ---------------------------------------------------------------------------
// Bank app (shared by the Android and the iPhone in app mode)
// ---------------------------------------------------------------------------

function TransferStatus({ app }: { app: AppView }) {
  const t = app.transfer;
  let cls = "";
  let title: ReactNode = null;
  let sub = "";
  switch (t.status) {
    case "sending":
      title = (
        <>
          <span className="spinner" />
          <span>Sending</span>
        </>
      );
      sub = "Processing your transfer";
      break;
    case "held":
      cls = " is-held";
      title = (
        <>
          <Pause />
          <span>On hold - under review</span>
        </>
      );
      sub = "Not debited. The bank is checking this payment.";
      break;
    case "pending":
      cls = " is-held";
      title = (
        <>
          <Pause />
          <span>Waiting for confirmation</span>
        </>
      );
      sub = "Confirm on your trusted device to continue.";
      break;
    case "settled":
      cls = " is-sent";
      title = (
        <>
          <CheckFilled />
          <span>Sent</span>
        </>
      );
      sub = `Settled. Balance now AED ${app.balance.toLocaleString("en-US")}.`;
      break;
    case "cancelled":
      cls = " is-cancelled";
      title = (
        <>
          <ErrorCircle />
          <span>Cancelled</span>
        </>
      );
      sub = "Nothing was debited.";
      break;
    case "rejected":
      cls = " is-cancelled";
      title = (
        <>
          <ErrorCircle />
          <span>Refused</span>
        </>
      );
      sub = "The bank refused this transfer.";
      break;
    default:
      break;
  }
  return (
    <div className={`transfer-status${cls}`}>
      <div className="transfer-status-title">{title}</div>
      <div className="transfer-status-sub">{sub}</div>
    </div>
  );
}

function BankApp({ app, onRetry }: { app: AppView; onRetry?: () => void }) {
  const screen = (name: AppView["screen"]) => `app-screen${app.screen === name ? " is-active" : ""}`;
  return (
    <>
      <div className="app-bar">
        <Shield />
        <span className="app-bar-title">Demo Bank</span>
        <span className="app-bar-user">{app.user}</span>
      </div>

      <div className="app-screens">
        <div className={screen("login")} aria-hidden={app.screen !== "login"}>
          <div className="app-h">Sign in</div>
          <div className="field is-ok">
            <span className="field-label">Customer ID</span>
            <span className="field-input">{app.customerId}</span>
          </div>
          <div className={`field${app.login.ok ? " is-ok" : ""}`}>
            <span className="field-label">Password</span>
            <span className="field-input">
              <span className="mono">{app.login.filled ? "••••••••••" : ""}</span>
              <Tick />
            </span>
          </div>
          <div className={`field${app.login.ok ? " is-ok" : ""}`}>
            <span className="field-label">SMS code</span>
            <span className="field-input">
              <span className="mono">{app.login.filled ? "482 913" : ""}</span>
              <Tick />
            </span>
          </div>
          <div className="app-btn">Sign in</div>
          <div className={`app-result${app.login.success ? " is-shown" : ""}`}>
            <CheckFilled />
            Login successful
          </div>
        </div>

        <div className={screen("home")} aria-hidden={app.screen !== "home"}>
          <div className="app-h">{app.greeting}</div>
          <div className="acct-card">
            <div className="acct-card-label">Current account</div>
            <Money className="acct-card-amount" value={app.balance} />
          </div>
          <div className="quick-actions">
            <div className="quick-action">
              <TransferGlyph />
              Transfer
            </div>
            <div className="quick-action">
              <PayeeGlyph />
              Beneficiaries
            </div>
          </div>
        </div>

        <div className={screen("beneficiary")} aria-hidden={app.screen !== "beneficiary"}>
          <div className="app-h">Add beneficiary</div>
          <div className="field">
            <span className="field-label">Name</span>
            <span className="field-input">{app.beneficiary.name}</span>
          </div>
          <div className="field">
            <span className="field-label">IBAN (synthetic)</span>
            <span className="field-input">
              <span className="mono mono--iban">{app.beneficiary.iban}</span>
            </span>
          </div>
          <div className="app-btn">Add beneficiary</div>
          <div className={`app-result${app.beneficiary.added ? " is-shown" : ""}`}>
            <CheckFilled />
            Beneficiary added
          </div>
        </div>

        <div className={screen("transfer")} aria-hidden={app.screen !== "transfer"}>
          <div className="app-h">Transfer</div>
          <div>
            <div className="transfer-meta">To {app.transfer.to}</div>
            <div className="transfer-amount">AED {app.transfer.amount.toLocaleString("en-US")}</div>
            <div className="transfer-meta">From current account, AED {app.transfer.from.toLocaleString("en-US")}</div>
          </div>
          <div className="app-btn">Send now</div>
          <TransferStatus app={app} />
        </div>
      </div>

      <div className={`phone-lockout${app.lockout ? " is-shown" : ""}`} aria-hidden={!app.lockout}>
        {app.lockout && (
          <>
            <div className="lockout-icon">
              <Padlock fill="#fff" />
            </div>
            <div className="lockout-title">{app.lockout.title}</div>
            <div className="lockout-sub">{app.lockout.sub}</div>
            <div className="lockout-retry">
              <button
                type="button"
                className={`lockout-retry-btn${app.lockout.retry.pressed ? " is-pressed" : ""}`}
                disabled={app.lockout.retry.busy}
                onClick={onRetry}
              >
                {app.lockout.retry.busy ? "Retrying..." : "Retry transfer"}
              </button>
              <div className={`lockout-refused${app.lockout.retry.refused ? " is-shown" : ""}`} role="status">
                {app.lockout.retry.refused ?? ""}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// iPhone
// ---------------------------------------------------------------------------

function Push({ push, onVerify }: { push: PushView | null; onVerify(response: "CONFIRM" | "DENY"): void }) {
  const answerable = push?.state === "pending" || push?.state === "sending";
  return (
    <div className={`push${push ? " is-shown" : ""}`} aria-live="polite" aria-hidden={!push}>
      <div className="push-head">
        <span className="push-icon">
          <Shield />
        </span>
        <span className="push-app">Demo Bank security</span>
        <span>now</span>
      </div>
      <div className="push-title">{push?.title ?? ""}</div>
      <div className="push-body">{push?.body ?? ""}</div>
      {answerable ? (
        <div className="push-actions">
          <button
            type="button"
            className="push-btn push-btn--deny"
            disabled={push.state === "sending"}
            onClick={() => onVerify("DENY")}
          >
            No, it wasn&apos;t me
          </button>
          <button type="button" className="push-btn" disabled={push.state === "sending"} onClick={() => onVerify("CONFIRM")}>
            Yes, it was me
          </button>
        </div>
      ) : push ? (
        <div className={`push-answer push-answer--${push.state}`}>
          <CheckCircle />
          <span>{push.state === "denied" ? "Answered: not me" : "Answered: it was me"}</span>
        </div>
      ) : null}
      {push?.error && (
        <div className="push-error" role="alert">
          {push.error}
        </div>
      )}
    </div>
  );
}

function IosStatus({ left }: { left: ReactNode }) {
  return (
    <div className="phone-status">
      {left}
      <span className="phone-status-right">
        <Wifi />
        <IosBattery />
      </span>
    </div>
  );
}

interface IPhoneProps {
  phone: CustomerView["phone"];
  onVerify(response: "CONFIRM" | "DENY"): void;
  onRetry?: () => void;
}

/** iPhone 15 Pro: lock screen with the bank widget and the push, or the bank app. */
export function IPhone({ phone, onVerify, onRetry }: IPhoneProps) {
  const app = phone.mode === "app" ? phone.app : null;
  const left =
    phone.status === "no-service" ? (
      <span className={`no-service${phone.serviceAlert ? " is-alert" : ""}`}>No service</span>
    ) : (
      <span className="phone-status-left">
        {app ? phone.lockTime : null}
        <SignalBars />
      </span>
    );
  return (
    <div className={`phone phone--iphone${phone.awake ? " is-awake" : ""}${app ? " is-app" : ""}`}>
      <div className="phone-screen">
        <div className="phone-island" />
        <IosStatus left={left} />
        <div className="phone-dim" />
        {app ? (
          <BankApp app={app} onRetry={onRetry} />
        ) : (
          <div className="lock">
            <span className="lock-focus">
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M7.6 1A5 5 0 1 0 11 8.4 4.2 4.2 0 0 1 7.6 1Z" fill="currentColor" />
              </svg>
              {phone.status === "no-service" ? "Sleep" : "Personal"}
            </span>
            <div className="lock-date">{phone.lockDate}</div>
            <div className="lock-time">{phone.lockTime}</div>

            <div className={`bank-widget${phone.widget.protected ? " is-protected" : ""}`}>
              <div className="bank-widget-label">
                <span>Current account</span>
                <span>Demo Bank</span>
              </div>
              <Money className="bank-widget-amount" value={phone.widget.balance} />
              <div className="bank-widget-status">
                {phone.widget.protected && <CheckCircle />}
                <span>{phone.widget.status}</span>
              </div>
            </div>

            <Push push={phone.push} onVerify={onVerify} />

            <div className="lock-bottom">
              <span className="lock-round">
                <Torch />
              </span>
              <span className="lock-round">
                <Camera />
              </span>
            </div>
          </div>
        )}
        <div className="home-indicator" />
      </div>
    </div>
  );
}

/** A second iPhone that only shows the bank app (scenario C, new device). */
export function AppIPhone({ app, time }: { app: AppView; time: string }) {
  return (
    <div className="phone phone--iphone is-awake is-app">
      <div className="phone-screen">
        <div className="phone-island" />
        <IosStatus
          left={
            <span className="phone-status-left">
              {time}
              <SignalBars />
            </span>
          }
        />
        <div className="phone-dim" />
        <BankApp app={app} />
        <div className="home-indicator" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

/** Samsung Galaxy A54 running the bank app. */
export function Android({ app, time, onRetry }: { app: AppView; time: string; onRetry(): void }) {
  return (
    <div className="phone phone--android">
      <div className="phone-screen">
        <div className="phone-punch" />
        <div className="phone-status">
          <span className="phone-status-left">
            <span>{time}</span>
            <span className={`sim-flag${app.simFlag ? " is-shown" : ""}`}>New SIM</span>
          </span>
          <span className="phone-status-right">
            <SignalBars />
            <AndroidBattery />
          </span>
        </div>
        <BankApp app={app} onRetry={onRetry} />
      </div>
    </div>
  );
}
