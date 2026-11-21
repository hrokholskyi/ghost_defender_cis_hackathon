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
