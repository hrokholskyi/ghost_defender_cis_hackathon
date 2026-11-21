# Decision log

## 2026-11-21 - Stack and project shape

Next.js 16 (App Router) + TypeScript, in-memory state on `globalThis`, vitest for tests, plain CSS (no Tailwind).
This is the stack the case description prefers.
Plain CSS was picked so the standalone animated demo (`demo/index.html`) can be ported to the dashboard 1:1.

## 2026-11-21 - Contract first, then parallel agents

`src/lib/types.ts` is the shared contract, written before any agent started.
Phase 1 runs three Opus agents in parallel: animated HTML demo, bank core (risk engine, gateways, API, tests), AI investigator.
The investigator gets its tools by injection (`InvestigationTools`), already bound to one session and one payment, so it could be built without the core.
A placeholder investigator in `src/lib/investigator/index.ts` lets the core be tested alone.
The dashboard (phase 2) starts only after the demo and the core are merged, because it ports the demo design and calls the real API.

## 2026-11-21 - Protective actions are code, the LLM only recommends

The payment gateway decides HOLD and session restriction synchronously from the deterministic Risk Engine, before any debit.
The AI investigation runs after that decision, asynchronously.
Its recommendation goes through the policy gateway, which can only tighten protection and never release a hold.
Rejected: letting the LLM call `hold_payment` or release tools directly, because the case requires that free model text cannot lift a mandatory block and that a missing LLM never lets a high-risk payment through.

## 2026-11-21 - UI updates by polling, not SSE

The dashboard polls `GET /api/state` about twice per second.
Rejected SSE: more moving parts in Next.js route handlers for no visible gain in a single-screen demo.

## 2026-11-21 - Scenario cursor lives on the server

`POST /api/scenarios/{id}/start` and `POST /api/scenarios/next` run demo steps through the same domain functions as the public routes.
Rejected: a client-side step-to-request mapper, because it duplicates logic in the UI and tests would not cover it.

## 2026-11-21 - Default investigator model is claude-sonnet-5-5

The investigation is shown live in a 5-minute pitch, so several tool-use round trips must finish in seconds.
Sonnet was picked over Opus for latency.
`GLD_MODEL` overrides it.
No `ANTHROPIC_API_KEY` was present on the dev machine at start, so end-to-end checks ran on the deterministic fallback.

## 2026-11-21 - vitest 5 needs @types/node 22

`create-next-app` pins `@types/node@^20`, and vitest 5.1 fails to install with it (peer conflict).
Bumped `@types/node` to `^22`, which also matches the local Node 22.

## 2026-11-21 - Investigator engine is Devin, not Claude

Roman: the AI investigator must be Devin, per the hackathon constraints.
This replaces the earlier "claude-sonnet-5-5" decision; the Claude path and the `@anthropic-ai/sdk` dependency are dropped.
The investigator agent was redirected mid-task to deliver only the deterministic fallback plus an internal `LlmEngine` seam; the Devin engine plugs into that seam in a follow-up task.
`InvestigationEngine` is now `"devin" | "deterministic-fallback"`.

## 2026-11-21 - Devin API facts that shape the design (docs.devin.ai, read today)

Use v3: `POST https://api.devin.ai/v3/organizations/{org_id}/sessions`, `Authorization: Bearer cog_...`; v1/v2 and `apk_` keys are legacy.
Verdict comes back through `structured_output_schema` (JSON Schema draft 7), read with `GET .../sessions/{devin_id}`; done when `status_detail` is `finished` or `status` is `exit`.
REST is polling only, docs say not faster than every 10 s, no webhooks; no documented session start or run time, so latency must be measured with a real key.
Devin has no function-calling API: it runs on its own VM, so "tools" must be HTTP endpoints on a public URL of our app (or an org-level MCP server, which cannot be set per session through the API).
Consequence: tool steps are reported when Devin hits our endpoints, the verdict arrives by polling, and the time cap for the engine must be minutes, not the 45 s planned for Claude.

## 2026-11-21 - Investigator seam merged: engine output is never trusted

The LLM engine plugs in as `LlmEngine` in `src/lib/investigator/index.ts`; the orchestrator owns timeline reporting, the time cap, zod validation and the switch to the fallback.
The verdict's `incidentId` always comes from a real `create_incident` result, never from engine text, and the orchestrator opens the incident itself when an engine recommends a hold without opening one.
`create_incident` input from an engine is validated before it reaches the core.
The default engine cap is 45 s, which was sized for Claude; the Devin engine must pass a larger `engineTimeoutMs`.
For Devin, the HTTP tool endpoint must map tool names to methods on the tracked `tools` object and reject unknown names; the orchestrator does not do that.

## 2026-11-21 - Bank core merged; integration miss on the engine id

The core branch still wrote engine id `"claude"` in `investigations.ts`, because the contract changed to `"devin"` on main after that agent had started.
Typecheck caught it after the merge; fixed with a one-line commit.
Lesson: a contract change during parallel work must be sent to every running agent, not only to the one it mainly concerns.

## 2026-11-21 - Core decisions reported by the bank core agent

Routes stay dynamic by reading `request.headers` plus `Cache-Control: no-store`, because `cacheComponents: true` removes `export const dynamic`, and `connection()` throws when a handler is called directly from a test.
In scenario B a retry of the held payment returns 403 `SESSION_RESTRICTED`, not 409, because the session check runs first; 409 `PAYMENT_HELD` is covered by a separate HIGH (score 60) case.
The typical amount is the median of all SETTLED payments, not only seed history.
A trusted device sending a large amount to a known beneficiary scores only 20 (LOW) and is allowed: a known gap of the demo point model, left as is.
Resets bump an `epoch`, so an investigation started before a reset cannot write into the new state.

## 2026-11-21 - Simulated clock drift found, fix delegated

The clock runs in real time between scripted steps, so a presenter who waits more than 60 s between clicks gets drifted timestamps and wrong "minutes" in the evidence.
Fix: cap the clock one second before the next scripted step while a scenario has steps left.

## 2026-11-21 - Devin engine built on the recommended options while Roman's answers are pending

Asked Roman twice: (1) which Devin credentials exist, (2) tunnel, server deploy, or no public URL.
No answer yet, and the hackathon budget is 4 hours, so the engine is being built for the recommended options: v3 API with a `cog_` key, and HTTP tool endpoints on a public URL (`GLD_PUBLIC_URL`).
No tunnel or deployment is set up without his go-ahead.
If he picks the legacy v1 key or "no public URL", the client or the tool transport must be reworked.

## 2026-11-21 - Devin engine design

Verdict arrives over two channels, first wins: Devin POSTs it to our `submit_verdict` endpoint (instant), and the backend polls `structured_output` every 10 s as a backup.
Rejected polling only: 10 s granularity plus session wind-down adds visible delay in a live demo.
The one-time tool token is put into the prompt, not into `session_secrets`: the runtime behaviour of session secrets is unverified, and the token is bound to one investigation, seven calls, and 10 minutes.
A `proxy.ts` guard makes only `/api/investigations/tools/*` reachable on the public host, because `/api/state` returns simulator session tokens.
Engine cap for Devin is 240 s (`GLD_DEVIN_TIMEOUT_MS`), since session duration is undocumented.

## 2026-11-21 - Devin engine merged, not yet run against the real API

Built and tested with a fake Devin client and, by the agent, on a real `next start` server against a local fake Devin API that curls our endpoints.
Deviations from my brief, accepted: `submit_verdict` validates the shape and answers 400 with the bad field so Devin can resubmit (raw pass-through would send one typo straight to the fallback); structured output is also accepted in `waiting_for_user` / `waiting_for_approval`; prompt examples use `<...>` placeholders so they do not bias the verdict.
Open risk for the first live run: if the tunnel rewrites `Host` to localhost and drops `x-forwarded-host`, the public guard sees every request as local and `/api/state` is exposed. Check `curl <public>/api/state` returns 404 right after starting a tunnel.
Other unverified points: exact create-session body acceptance, presence of `url` in the response, session duration against the 240 s cap, accepted `devin_mode` values, ACU cost per run.

## 2026-11-21 - Demo becomes a guided explainer with chapters

Roman asked for English subtitles: present and explain the screen sections first, then explain each case.
Read as: Tour, Case A, Case B, Case C, Closing card, with one bottom subtitle track replacing the top caption row.
Rejected adding only step subtitles to case B: chapters cover both readings of "case", and `?chapter=b&only=1` still gives the short attack-only run.
The live dashboard is being ported from the pre-subtitle demo; it keeps its narrator caption for now.

## 2026-11-21 - Devin reaches the tools through a named Cloudflare tunnel

Roman chose: Devin makes real tool calls, through `cloudflared`, on a subdomain of his own domain; credentials will be a v3 PAT or service user key (`cog_`), not the legacy key.
Rejected a quick tunnel on trycloudflare.com: the URL changes on every start, so `GLD_PUBLIC_URL` would have to be edited before each run.
Rejected "no public URL, backend collects tool results": Devin would not make the tool calls itself.
`cloudflared` 2026.10.7 is installed on the Mac but not logged in, so `cloudflared tunnel login` (browser) must be run by Roman once.

## 2026-11-21 - Dashboard merged and checked end to end by the lead

Played scenarios A, B and C in a browser against `next start`, plus "Retry transfer" and "No, it wasn't me" in B: backend state and UI agree (B: HELD, 92,000, RESTRICTED, 15/40/55/75/90, INC-0001; after DENY: CANCELLED, REVOKED, CONFIRMED_ATO).
The backend applies a whole event at once, so the UI stages the TRANSFER event itself (55 -> 75 -> HOLD stamp -> 90 -> RESTRICTED stamp -> tool calls), driven by `Payment.action` and signal `cumulative` values.
Workarounds in the view-model, because the snapshot lacks the data: run id (uses scenario id plus the `seq` of `SCENARIO_STARTED`), which step fired a signal (matches `detectedAt` to the step clock), typical amount (median computed in the UI).
The dashboard was ported from the demo before the subtitle band existed, so it keeps the caption row at the top; the demo and the dashboard differ there on purpose for now.
Three polish defects found in my check and delegated: verdict text clamped at 4 lines, engine badge shown when no investigation ran, customer actions tagged in attacker red in A and C.
Not yet tested live: a real Devin run and a real 422 on verification CONFIRM.

## 2026-11-21 - Tunnel created and the public guard verified through it

A named Cloudflare tunnel with one proxied CNAME for the tool endpoints, origin `http://localhost:3000`.
Checked through the real tunnel: `/`, `/api/state`, `/api/reset`, `/api/payments` and `/_next/static/*` answer 404 on the public host; tool endpoints answer the generic 401 without a valid token, also for unknown tool names.
So the tunnel passes the public `Host` to the origin and the guard works; the open risk from the engine merge entry is closed.
`cloudflared tunnel route dns <tunnel> <bare-name>` appends the zone of the logged-in certificate, which is how the zone name was found without asking.
Still open: Devin key and org id are not in `.env.local` yet, so no real Devin run has happened.

## 2026-11-21 - First real Devin runs: 27 to 28 seconds, verdict correct

Roman created a service user key; the org id was read from `GET https://api.devin.ai/v3/self`, which returns `principal_type`, `service_user_id` and `org_id`.
Two runs of scenario B with real Devin through the tunnel: session created in about 4 s, five read tools called at about 14 to 16 s, `create_incident` at about 26 s, verdict submitted at about 27 to 28 s.
Both verdicts: `LIKELY_ACCOUNT_TAKEOVER`, `HOLD_AND_RESTRICT`, evidence lines traceable to tool results; the gateway had already held and restricted before Devin started.
The create body was accepted as sent, the response carried `url`, and the verdict arrived through `submit_verdict`, so the 10 s polling was never the limiting factor.
The 240 s cap is generous; it stays as the safety net. No `devin_mode` is set, and at 28 s there is no need to try `fast` before the pitch.
Not exercised live: timeout and terminate, suspended or waiting sessions, rate limits, ACU cost.

## 2026-11-21 - Dashboard polish merged

Verdict card now shows the full summary and clamps only when it cannot fit (it still clamps at 1280x720 with the long fallback text).
Engine badge is hidden until an investigation exists; customer actions in scenarios A and C are tagged "Customer".
The polish agent ran `agent-browser close --all` and closed a browser session that belonged to other work; briefs must say "close only your own named session".
