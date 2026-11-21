# Ghost Login Defender

Ghost Login Defender is an AI agent inside a simulated bank that stops account takeover.
The password and the SMS code are correct and the login succeeds, but the session is not the real customer.
A deterministic Risk Engine scores the session, the Payment Gateway holds the transfer before any debit, and an investigation agent then calls tools, opens an incident and explains what it found.

**This is a simulation.**
**All data is synthetic.**
**No real bank, customer, telco or payment system is involved.**

Stack: Next.js 16 (App Router), TypeScript, in-memory state, vitest.

## Quick start

Prerequisites:

- Node.js 22 (the project was developed and tested on 22.13.1).
- npm.

Install and run:

```bash
npm ci
npm run dev
```

Open http://localhost:3000.

No configuration is needed.
Without Devin settings the investigation runs on the deterministic fallback, and the dashboard says which engine ran and why.

### How to play

The dashboard shows a customer phone, a second phone for the session under watch, the Risk Engine, the Payment Gateway and the investigation timeline.

- Pick a scenario with the **A**, **B** or **C** buttons in the top bar.
- **Next event** runs the next step of the scenario.
  Keyboard: Right arrow or Space.
- **Autoplay** runs the remaining steps with a pause between them.
  Keyboard: P.
- **Restart** resets the simulator and the scenario.
  Keyboard: R.
- On the customer phone, the push message has two buttons: "Yes, it was me" (confirm the payment) and "No, it wasn't me" (deny it).
- On the attacker phone, "Retry transfer" tries the held payment again.
  The gateway refuses it.
- "Full audit log" opens the complete audit trail.
  Press Escape to close it.

Presenter keys are ignored while you type in an input field and when Ctrl, Cmd or Alt is held.

## The standalone demo

`demo/index.html` is a scripted, animated explainer of the product.
It is one HTML file with no dependencies.
It makes no network calls and talks to no backend.
Everything on screen is a pre-written script, so it can run offline.

It is not served by Next.js.
Open the file directly in a browser, for example `open demo/index.html` on macOS.

It has five chapters: Tour, Case A (normal customer), Case B (account takeover), Case C (legitimate phone change) and a closing card.
A subtitle track explains each step.

Keys:

| Key | Action |
| --- | --- |
| Space | Play or pause |
| Right arrow | Next step |
| Shift + Right arrow | Next stage |
| r | Restart the current chapter |
| R (Shift + r) | Restart from the Tour |
| 0, 1, 2, 3 | Open Tour, Case A, Case B, Case C |
| c | Show or hide subtitles |
| ] and [ | Faster and slower playback |

URL parameters:

| Parameter | Effect |
| --- | --- |
| `chapter=tour\|a\|b\|c\|closing` | Start in this chapter |
| `stage=N` | Jump to stage N (Case B unless `chapter` is given) |
| `autoplay=1` | Start playing at once |
| `only=1` | Play only the opened chapter and then stop |
| `subs=0` | Start with subtitles off |
| `engine=fallback` | Show the deterministic fallback instead of Devin in the investigation panel |
| `speed=0.75..2` | Playback speed (default 1) |

The short attack-only run is `demo/index.html?chapter=b&only=1&autoplay=1`.

## Architecture

```text
simulator events (login, SIM swap, add beneficiary, transfer)
        |
        v
  Risk Engine  (pure functions, six signals, score 0-100)
        |
        v
  Payment Gateway  (decides before any debit: allow, step-up, hold, hold and restrict)
        |                          |
        | tighten / loosen         | starts, asynchronously
        v                          v
  Policy Gateway  <-----  Investigation (Devin session, or deterministic fallback)
  (only code path that        |  calls tools, opens an incident, returns a verdict
   changes holds and          |  = a recommendation
   restrictions)              v
        |                 Audit log  <- every decision, allowed or denied
        v
  Verification: push to the customer's trusted device
```

Key design rule: protective actions are code, and the investigator only recommends.
The Payment Gateway holds the payment and restricts the session from the Risk Engine result, before any debit, without waiting for any model.
The investigator's recommendation goes through the Policy Gateway as the actor `ai-investigator`.
For that actor the Policy Gateway can only tighten protection (hold, restrict).
It cannot release a hold, cancel a payment or lift a restriction.
Only the `customer-verification` actor can loosen, and only with proof of a valid answer from a trusted session.

| Component | File | Role |
| --- | --- | --- |
| Shared contract | `src/lib/types.ts` | Types, route list, error codes |
| Config | `src/lib/config.ts` | Risk weights, thresholds, windows (demo values) |
| Bank simulator | `src/lib/bank.ts`, `src/lib/store.ts` | Login, devices, beneficiaries, sessions, seed data, in-memory state |
| Risk Engine | `src/lib/risk-engine.ts` | Deterministic point model, no store access, no model call |
| Payment Gateway | `src/lib/payment-gateway.ts` | Decides every transfer before debit, refuses retries of held payments |
| Policy Gateway | `src/lib/policy-gateway.ts` | Permission matrix for hold, restrict, release, cancel, revoke, lift |
| Verification | `src/lib/verification.ts` | Push to the trusted device, confirm or deny |
| Investigations | `src/lib/investigations.ts` | Starts the investigation, applies the recommendation, always opens an incident for a held payment |
| Incidents | `src/lib/incidents.ts` | Incident records |
| Investigation tools | `src/lib/tools.ts` | Six tools bound to one session and one payment |
| Investigator | `src/lib/investigator/` | Orchestrator, deterministic fallback, Devin engine |
| Devin engine | `src/lib/investigator/devin/` | API client, engine, one-time grants, tool endpoint, prompt, public guard |
| Public guard | `src/proxy.ts` | On the public host, only the tool endpoints answer |
| Scenarios | `src/lib/scenario-catalog.ts`, `src/lib/scenarios.ts` | Scenarios A, B, C and the server-side cursor |
| Audit | `src/lib/audit.ts` | Append-only audit log |
| API routes | `src/app/api/` | HTTP face of the domain functions |
| Dashboard | `src/components/`, `src/lib/ui/` | UI, polls `GET /api/state` about twice per second |
| Standalone demo | `demo/index.html` | Scripted explainer, no backend |

## Risk model

The score is the sum of fixed points for the signals that fired, capped at 100.
Signals are sticky: once a signal fires for a session, it keeps its points and its first detection time.

| Signal | Points | Rule |
| --- | --- | --- |
| `UNKNOWN_DEVICE` | 15 | The login device was not in the customer's device history at login |
| `RECENT_SIM_SWAP` | 25 | A SIM swap was confirmed at most 60 minutes before the session login (and not after it) |
| `UNUSUAL_NETWORK` | 10 | The login network country differs from the customer's home country |
| `NEW_BENEFICIARY` | 15 | A beneficiary was added in this session, or the transfer goes to a beneficiary with no settled payments |
| `UNUSUAL_AMOUNT` | 20 | The transfer is at least 5 times the typical amount (the median of all settled payments) |
| `RAPID_SEQUENCE` | 15 | The transfer is requested 0 to 10 minutes after login, to a beneficiary added in the same session |

| Band | Score | Action | What happens |
| --- | --- | --- | --- |
| LOW | 0-29 | `ALLOW` | The payment settles and the session is monitored |
| ELEVATED | 30-59 | `STEP_UP` | The payment waits as `PENDING_VERIFICATION`, nothing is debited, a push goes to the trusted device |
| HIGH | 60-79 | `HOLD` | The payment is `HELD` before debit, a push goes to the trusted device, an investigation starts |
| CRITICAL | 80-100 | `HOLD_AND_RESTRICT` | Same as HOLD, and the session is `RESTRICTED` (no payments, no beneficiary changes) |

The weights and thresholds are demo values.
They are not a calibrated model and were not tuned on real data.
The dashboard shows this disclaimer next to the scores.

## Scenarios

All scenarios run through the same domain functions as the public routes.
The seed data has one customer with a balance of AED 92,000, one trusted iPhone and eight settled payments with a median of AED 3,000.

| Scenario | Steps | Expected result |
| --- | --- | --- |
| A - Normal customer | 1. Login from the trusted iPhone at home. 2. Transfer AED 3,000 to a known landlord beneficiary. | Risk 0 (LOW). Payment `SETTLED` at once. Balance AED 89,000. No investigation. |
| B - Account takeover | 1. Login from a new Android phone. 2. The telco signal reports a SIM swap 45 minutes before login. 3. The attacker adds a new beneficiary. 4. The attacker requests AED 85,000 to it. | Risk 15, then 40, then 55, then 90 (CRITICAL). Payment `HELD` before debit. Attacker session `RESTRICTED`. Push to the trusted iPhone. Incident opened. Balance stays AED 92,000. |
| C - Legitimate phone change | 1. Login from a new iPhone 16 at home. 2. Transfer AED 3,200 to a known family beneficiary. | Risk 15 (LOW), from the new device only. Payment `SETTLED`. Session stays `ACTIVE`. No incident. Balance AED 88,800. |

In scenario B the transfer scores 75 on its own signals (new device, SIM swap, new beneficiary, unusual amount) before the rapid-sequence signal adds 15 to reach 90.
A retry of the held payment from the restricted session gets `403 SESSION_RESTRICTED`.
Scenario B also keeps the customer's own iPhone signed in from the evening before, so the push has a trusted session to reach.

## Investigation agent

After the gateway has already protected the money, an investigation starts in the background.
It never blocks the HTTP response of the payment.

### Tools

The investigator has six tools.
They are bound to one session and one payment, so it cannot query other sessions or customers.

| Tool | Returns |
| --- | --- |
| `get_device_history` | The current device and the customer's known devices |
| `get_sim_status` | The synthetic telco signal and minutes between the SIM swap and login |
| `get_session_activity` | Login time, network, session events, minutes from login to transfer |
| `get_payment_history` | Settled count, typical and maximum amount, ratio of the current amount to typical |
| `check_beneficiary` | Masked IBAN, prior settled payments, whether it was added in this session |
| `create_incident` | Opens an incident (once per payment: a second call returns the existing one) |

### Devin path

When Devin is configured (see the table below), the backend does the following:

1. It creates a Devin session through the Devin API v3 (`POST /v3/organizations/{org_id}/sessions`).
   The request carries the prompt, a JSON schema for the structured output, an optional mode and an optional ACU (Agent Compute Units) limit.
2. It issues a one-time tool token and puts it in the prompt.
   Only the SHA-256 hash is kept.
   The token is tied to one investigation, expires after 10 minutes and allows at most 40 tool calls.
   It ends when the verdict is submitted, when the run is aborted or when it expires.
3. Devin runs on its own cloud machine and calls seven HTTP endpoints on this app, `GET` or `POST /api/investigations/tools/{tool}` with `Authorization: Bearer <token>`.
   Six are the tools above.
   The seventh is `submit_verdict`.
   Read tools accept `GET` or `POST`, `create_incident` and `submit_verdict` accept `POST` only.
   Missing, wrong, expired and ended tokens all get the same 401.
   Unknown tool names get 404.
4. The verdict can arrive on two channels, and the first one wins.
   Devin can `POST` it to `submit_verdict`, which is instant, and the endpoint answers 400 with the bad field if the shape is wrong so Devin can fix it.
   Or the backend polls the session every 10 seconds and reads the structured output once the session is finished.
5. The whole Devin phase has a time cap (default 240 seconds).
6. The orchestrator validates the verdict.
   The incident id always comes from a real `create_incident` result, never from model text.
   If the verdict recommends a hold and no incident exists, the orchestrator opens one.
7. On any failure, the engine switches to the deterministic fallback.
   Failures include: session start error, three failed status checks in a row, a session that ends in error or is suspended, a session stuck waiting for user input or approval, an invalid verdict and the time cap.
   The fallback reason is stored and shown in the UI.
   A failed run terminates the Devin session on a best-effort basis.

Devin calls show up on the dashboard timeline as they arrive.

### Deterministic fallback

The fallback calls the five read tools in a fixed order and builds the evidence from the real tool results.
It recommends the action the Risk Engine already chose, and it opens an incident only when that action holds the payment.
It is also used when Devin is not configured or when `GLD_FORCE_FALLBACK=1`.
It makes no model call.

### Public-host guard

Devin must reach the app from the internet, but `GET /api/state` returns simulator session tokens.
So `src/proxy.ts` checks the host of every request.
On the host named in `GLD_PUBLIC_URL` only `/api/investigations/tools/*` answers, and everything else is a 404.
Other hosts, such as `localhost`, are not affected.
It also looks at `x-forwarded-host`.
`GLD_PUBLIC_DASHBOARD=1` turns the guard off on purpose.

### Configuration

Copy `.env.example` to `.env.local`.
All variables are optional.
Devin runs only when `DEVIN_API_KEY`, `DEVIN_ORG_ID` and `GLD_PUBLIC_URL` are all set and `GLD_FORCE_FALLBACK` is not `1`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEVIN_API_KEY` | empty | Devin API v3 key (service user key or personal access token, prefix `cog_`) |
| `DEVIN_ORG_ID` | empty | Devin organization id, prefix `org-` |
| `DEVIN_API_BASE_URL` | `https://api.devin.ai` | Devin API base URL |
| `GLD_PUBLIC_URL` | empty | Public base URL of this app, reachable from the Devin machine |
| `GLD_PUBLIC_DASHBOARD` | empty | `1` also serves the dashboard and simulator routes on `GLD_PUBLIC_URL` |
| `GLD_DEVIN_MODE` | empty (organization default) | Devin mode name, for example `fast` or `normal` |
| `GLD_DEVIN_MAX_ACU` | empty (no limit) | Maximum ACUs for one investigation session, a positive integer |
| `GLD_DEVIN_TIMEOUT_MS` | `240000` | Time cap on the whole Devin phase, then the fallback takes over |
| `GLD_DEVIN_POLL_MS` | `10000` | Poll interval for the Devin session (minimum 1000, Devin docs discourage less than 10000) |
| `GLD_FORCE_FALLBACK` | empty | `1` forces the deterministic fallback even when Devin is configured |
| `GLD_STEP_DELAY_MS` | `600` | Pause between tool calls in the fallback, so the timeline animates |

An invalid optional value makes Devin count as not configured, and the UI reason names the value.

### Connect Devin

1. Create `.env.local` in the repo root:

   ```bash
   DEVIN_API_KEY=cog_...
   DEVIN_ORG_ID=org-...
   GLD_PUBLIC_URL=https://your-public-host.example
   ```

2. Make the app reachable at `GLD_PUBLIC_URL`.
   Devin runs on its own cloud machine, so `localhost` does not work.
   Use a tunnel to your local port 3000 (for example a Cloudflare tunnel) or a deployed host.
3. Start the app with `npm run dev`.
4. Check the guard: `curl <GLD_PUBLIC_URL>/api/state` must return 404.
   If it returns the state, stop and fix the tunnel, because the tunnel is hiding the public host from the guard.
5. Run scenario B on the local dashboard at http://localhost:3000.
   The top bar shows the Devin engine when it is configured.

## API

All bodies are JSON.
Every response has `Cache-Control: no-store`.
Errors have the shape `{ "error": { "code": "...", "message": "..." } }`.
`Bearer` means `Authorization: Bearer <session token>`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/state` | none | Full state snapshot, including session tokens (simulator only) |
| POST | `/api/reset` | none | Reset to seed data |
| POST | `/api/scenarios/{id}/start` | none | Reset and prepare scenario A, B or C |
| POST | `/api/scenarios/next` | none | Run the next step of the active scenario |
| POST | `/api/login` | none | Create a session (simulated login, no credentials) |
| POST | `/api/sim-swap` | none | Report a SIM swap (the synthetic telco signal) |
| POST | `/api/beneficiaries` | Bearer | Add a beneficiary (refused for restricted sessions) |
| POST | `/api/payments` | Bearer | Request a transfer. 200 for every gateway decision, 403 for a restricted or revoked session |
| POST | `/api/payments/{id}/execute` | Bearer | Retry a payment. Never bypasses a hold, answers 409 `PAYMENT_HELD` or 403 |
| POST | `/api/verifications/{id}/respond` | Bearer of the trusted target session | Answer the push with `CONFIRM` or `DENY` |
| GET, POST | `/api/investigations/tools/{tool}` | One-time investigation token | Tool endpoints for the Devin session |

Error codes: 400 `INVALID_REQUEST`, 401 `UNAUTHENTICATED`, 403 `SESSION_RESTRICTED`, `SESSION_REVOKED` and `NOT_TRUSTED_CHANNEL`, 404 `NOT_FOUND`, 409 `PAYMENT_HELD` and `CONFLICT`, 422 `INSUFFICIENT_FUNDS`.

## Tests

```bash
npm test
npm run typecheck
npm run lint
```

Current result: 14 test files, 124 tests, all passing.
`npm run typecheck` and `npm run lint` report no errors.

Tests live in `src/lib/__tests__` (bank core, 6 files), `src/lib/investigator/__tests__` (7 files) and `src/lib/ui/__tests__` (1 file).

What the tests prove:

| Acceptance criterion | Where |
| --- | --- |
| A held payment never settles, and the balance does not change | `scenarios.test.ts`, `routes.test.ts` (scenario B ends with the payment `HELD` and balance AED 92,000) |
| A retry does not bypass the hold | `scenarios.test.ts`, `routes.test.ts` (restricted session gets 403, active session gets 409 `PAYMENT_HELD`, settled payments never debit twice) |
| A legitimate payment from a separate trusted session is not blocked | `scenarios.test.ts` (the trusted iPhone pays a known beneficiary during the incident) |
| A new device alone does not block | `scenarios.test.ts` (scenario C: risk 15, payment settles, session stays active) |
| Every decision has an explanation | `risk-engine.test.ts`, `scenarios.test.ts` (signals carry evidence, payments carry reasons, the audit log records each step) |
| The investigator cannot release a hold | `policy-verification.test.ts` (release and lift requested by `ai-investigator` are denied and logged) |
| An investigator failure leaves the payment held | `fail-safe.test.ts` (the investigator throws, the payment stays `HELD`, the session stays `RESTRICTED`, an incident is still opened) |

The investigator tests also cover the Devin client, the Devin engine, the tool endpoint, the fallback and the public-host guard.
All of them run against a fake Devin API (`devin-fakes.ts`).

## What is a stub or simulated, and what is unverified

Simulated or stubbed:

- **The bank.** It is a small in-memory simulator with one customer, one account and seeded history.
- **Login.** It takes a device id and a network, with no password or SMS code.
  The "correct credentials" part of the story is only told by the scenarios.
- **The SIM signal.** It is a synthetic telco signal reported through `POST /api/sim-swap`.
  A real bank needs an authorised data source for this.
- **Push notification.** It is a verification record shown on the customer phone in the dashboard.
  No real push is sent.
- **Secure recovery.** After a denied payment, only an audit entry `SECURE_RECOVERY_STARTED` is written.
  Nothing resets credentials or contacts the customer.
- **State.** It is in memory and resets on restart.
  It is single process only, so there is no shared store, no persistence and no multi-instance mode.
- **The clock.** It is simulated, and scenario steps use fixed timestamps.
- **Session tokens.** They are exposed in `GET /api/state` on purpose, so the dashboard can act as both phones.
  This is acceptable only because it is a simulator.

Unverified:

- The Devin engine was built and tested against a fake Devin API.
  As of this writing, it has not been run against the real Devin API.
- Not yet confirmed with the real API: whether the create-session body is accepted exactly as sent, whether the response contains a session `url`, how long a session takes compared with the 240 second cap, which `devin_mode` values are accepted, and the ACU cost of one run.
- Not yet confirmed through a real tunnel: that the tunnel passes the public host to the guard (the `curl <public>/api/state` check above covers it).
- Devin's tool calls were tested only against a local fake that calls the endpoints with `curl`.

## Limitations and honest wording

- The risk weights and thresholds are demo values.
  They are not a calibrated model.
  This project makes no claim about detection accuracy, false positives or false negatives.
- The model has known gaps.
  For example, a trusted device sending a large amount to a known beneficiary scores only 20 (LOW) and is allowed.
- "AED 85,000 protected" means a held transfer inside a simulator.
  It is not a real prevented loss.
- A real bank would need, at least: IAM (identity and access management), a real payment rail, trusted verification channels, a durable audit store and an approved security policy.
  It would also need real telco data under a legal basis, review of the model, and monitoring of the model's own behavior.

## Repository layout

```text
demo/index.html              standalone animated explainer
src/app/                     Next.js App Router: page, layout, API routes
src/app/api/                 HTTP routes (state, reset, scenarios, login, payments, ...)
src/components/              dashboard UI
src/lib/                     domain: risk engine, gateways, bank, verification, incidents, scenarios
src/lib/investigator/        orchestrator, fallback, Devin engine
src/lib/investigator/devin/  Devin client, engine, grants, tool endpoint, prompt, public guard
src/lib/ui/                  dashboard view model, API client, presenter logic
src/lib/__tests__/           core tests
src/proxy.ts                 public-host guard
.env.example                 configuration template
```
