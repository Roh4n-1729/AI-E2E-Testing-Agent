# Project kickoff: AI E2E Testing Agent (final interview project)

I'm building the final-round project for an Agentic AI Engineering interview: an **AI-agent-driven end-to-end frontend testing tool**. Given a URL (plus an optional description) it crawls the app, plans test cases for the user flows, runs them with AI agents driving a real browser, **judges pass/fail from independent evidence**, and reports. It must be **generalised, not tied to one app**. **Hard deadline: Monday 2 Nov 2026.** Earlier and working beats sprawling and half-finished.

This file is the condensed result of the first working session (Thu 29 Oct) plus the first real runs. Treat every decision below as **agreed** unless I reopen it; items marked **PROPOSED** need my confirmation before you build them. Your job: help me build the real product step by step, so that I understand and can defend every line. I'll be asked to walk through any part of it.

I run the code on my machine (Windows, PowerShell) and paste back errors and output. You cannot reach external sites or the Anthropic API from your sandbox, so anything involving a real LLM call is verified by me; everything else is verified by you with mocks and a real Chromium before you hand it over.

---

## 1. Stack

| Concern                  | Choice                                                                                                                   | Why                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                 | **JavaScript (ESM) + JSDoc types**, checked with `tsc --checkJs` (`npm run check`)                                       | I decided against TypeScript for speed; JSDoc gives editor hints and CI type-checking                                                                                     |
| Runtime / CLI            | **Node 22**, `commander` CLI (`aie2e run`, `aie2e doctor`, `aie2e ui`)                                                   |                                                                                                                                                                           |
| Browser engine           | **Stagehand 3.7.3 (pinned) + Playwright 1.64.1**                                                                         | Stagehand's agent drives the browser; Playwright attaches over CDP for deterministic navigation, replay and **independent evidence**. **Not Stagehand v4** (no `agent()`) |
| Orchestration            | Hand-rolled LangGraph-style `StateGraph` today (`core/graph.js`); **PROPOSED: adopt `@langchain/langgraph` (MIT)**       | See §4 "LangGraph decision"                                                                                                                                               |
| LLM plumbing             | **Vercel AI SDK** (`ai` v5, `@ai-sdk/anthropic\|openai\|google`) for the planner and the visual judge (`generateObject`) | Provider swap; tested with `MockLanguageModelV2`                                                                                                                          |
| Models (testing)         | **`anthropic/claude-haiku-4-5`** default; `claude-sonnet-4-6` if Haiku is too weak                                       | **Not `claude-haiku-5-5`**: see §7 (thinking-signature bug in Stagehand 3.7.3)                                                                                            |
| Validation               | **Zod 4**                                                                                                                | Schemas for config, test cases, expectations, recordings are the source of truth                                                                                          |
| Tests                    | **Vitest** (unit + real-Chromium integration with a local test app and a mock LLM)                                       |                                                                                                                                                                           |
| Lint/format              | ESLint 9 (flat), Prettier, GitHub Actions CI (`check`, lint, format:check, test)                                         |                                                                                                                                                                           |
| Local UI **(PROPOSED)**  | **Vite + React (JS)**, Tailwind v4, shadcn/ui + Radix, lucide-react, Zustand                                             | Same design stack as my AI Presentation Builder, so I can defend it. Served by the CLI (`aie2e ui`)                                                                       |
| UI server **(PROPOSED)** | **Fastify (MIT) + `@fastify/static`**, SSE for events, CDP screencast for live view                                      | One local Node process: starts runs, streams events, serves reports and recordings                                                                                        |
| Licences                 | **Any open-source licence is allowed** (confirmed with the assignment). Record each dependency's licence in the README   |                                                                                                                                                                           |

Rejected: Stagehand v4, TypeScript, a hosted backend/DB, multi-model comparison UI, tracing platform (Langfuse/LangSmith) before the core works. See `docs/TRADEOFFS.md` (to be created).

---

## 2. Core architecture

```
 URL (+ description)
   │
   ▼
 crawl ──► plan ──► run (per test, parallel, own Chromium) ──► report
 (BFS)    (LLM)        │
                       ├─ CachingExecutor
                       │    ├─ no recording  → AgentExecutor (Stagehand agent) ── records steps
                       │    ├─ recording     → ReplayExecutor (plain Playwright, 0 LLM calls)
                       │    └─ step breaks   → agent continues from current page (self-heal, logged)
                       └─ EvidenceJudge (harness evidence only) ──► verdict ──► (record if pass)
```

### The invariants (do not break; each one is tested)

1. **The judge never trusts the agent.** Verdict = harness-collected evidence (DOM text, URL, selectors, console errors, failed network requests, a harness screenshot) vs. the test's expectations. `agentClaim` is recorded and compared (`claimMismatch`), never used for pass/fail.
2. **Vacuous expectations don't count.** The harness snapshots the start page _before_ the agent acts (`BrowserSession.baseline`). An expectation already true there is marked `vacuous`; a goal test needs at least one non-vacuous passing outcome check, else it **fails as "Inconclusive"**. (This caught `url includes "presentation"` matching the hostname.)
3. **Agents author and repair; plain Playwright replays.** A run is recorded as JSON steps **only if the judge passed it**. Replays make zero LLM calls.
4. **Healing must not hide regressions.** A step failure → the agent continues from the current page and the heal is logged (old/new selector, reason). A replay that completes but fails the judge → the agent re-attempts the goal from scratch on the live app; only if the _judge_ then passes is it a heal. If the agent also fails, the **failure stands** and the recording is untouched. Every heal appears in the report.
5. **No silent degradation.** A planner or LLM failure aborts the run with a clear error; a `visual` expectation with no LLM fails loudly rather than skipping.
6. **Ports and adapters.** Interfaces are JSDoc typedefs in `core/ports.js`; each day's work lands behind an interface so the demo path keeps working.

### Record / replay details

- Recording source: in DOM mode Stagehand's `act` tool returns `playwrightArguments = {selector (XPath), method, arguments, description}` (read from Stagehand source). `executor/steps.js` converts agent actions into `RecordedStep`s (`navigate | act | back | wait`).
- Unknown page-changing tools make a run **unrecordable** (it passes but isn't cached; the log says why).
- Replay waits for the page to stop changing (URL + text length stable) after each step and generously after the last (AI apps stream output).
- Recordings: `<out>/recordings/<testId>.json`, validated on load, keyed by `fingerprint = sha256(goal + startUrl + expectations)`.
- Planner output is cached (`planner/cachedPlanner.js`) so test ids stay stable across runs; otherwise recordings would never be hit.
- Known limit: if one `act` performs several low-level actions only the first is exposed; the replay can diverge, the judge fails it, the runner re-verifies with the agent (logged as a heal). Still to confirm on a real app.

---

## 3. Data model (Zod, `core/types.js`)

```js
Expectation = url{pattern, mode} | text-visible{text} | selector-visible{selector}
            | no-console-errors | no-network-failures | visual{question}   // visual = LLM yes/no on a HARNESS screenshot
TestCase    = { id(slug), title, goal(''=smoke), startUrl, expectations[], maxSteps?, tags[] }
RecordedStep= { index, kind:'navigate'|'act'|'back'|'wait', description, url?, selector?, method?, arguments? }
Recording   = { schemaVersion:1, testId, fingerprint, recordedAt, steps[] }
Verdict     = { status:'pass'|'fail'|'error', reason, checks[{expectation,passed,detail,vacuous?}], warnings[] }
TestResult  = { test, mode:'agent'|'replay'|'healed'|'deterministic', verdict, evidence, agentClaim?, claimMismatch, heals[], durationMs, llmUsage? }
RunReport   = { runId, startedAt, finishedAt, targetUrl, summary{total,passed,failed,errored,healed,claimMismatches,inputTokens,outputTokens}, results[] }
```

Exit codes: `0` all pass, `1` any fail, `2` any error (CI-friendly).

---

## 4. Agent design

### Crawler (lean)

Capped BFS (`maxPages` 8, `maxDepth` 2), same-origin only, skips `logout|sign-out|delete|remove|unsubscribe|destroy|deactivate|cancel` links and asset URLs, feeds a **site map** (titles, text excerpt, buttons, forms, links) to the planner. SPAs expose few links, so the planner must also work from page text and buttons.

### Planner (`planner/llmPlanner.js`)

`generateObject` with a flat, all-required schema. Always adds a deterministic **smoke test** first, plus 1–`maxTests` flow tests, each with 1–3 expectations about the END state. Prompt rules (learned from real runs): at least one expectation must be **false on the start page and true only after the goal**; never generic words or the hostname; visual questions test **one simple observable fact** (no stacked conditions like "full-screen with navigation controls"). Always appends `no-console-errors` and `no-network-failures`.

### Executor

`AgentExecutor` runs `session.stagehand.agent({ mode:'dom', model:{ modelName, thinkingEffort:'none' } })`, saves the agent's screenshots as evidence, returns replayable steps and token usage. `ReplayExecutor` + `CachingExecutor` as in §2. Screenshots from the agent are labelled `source:'agent'`; the judge's are `source:'harness'`.

### Judge (`judge/evidenceJudge.js`)

Deterministic first, LLM second (visual only). Console-error filtering ignores `Failed to load resource` for ignored network patterns (default `favicon.ico`). Case-insensitive `getByText` visibility checks with a 3 s wait.

### LangGraph decision (PROPOSED)

`@langchain/langgraph` v1.5.x is **MIT**. Reasons to adopt: this is an Agentic-AI-engineer interview and real LangGraph is recognised; `graph.stream({ streamMode: ['updates','custom'] })` gives per-node updates and node-emitted custom events (`config.writer`), which is exactly the live-UI feed; `Send` models the parallel per-test fan-out; optional checkpointer later. Reasons to wait: our 80-line `StateGraph` works and is tested; the swap costs about half a day and must not break the demo path. **Plan:** build a framework-independent **run-event bus first** (the UI consumes events, not graph internals), then swap the graph implementation behind `buildPipeline` as a time-boxed task. Cut if behind.

---

## 5. Product surface and user journey

### CLI (works today)

`aie2e run <url> [-d desc] [-g goal] [--expect-url] [--expect-text] [-c N] [--max-tests N] [--headed] [--no-cache] [--rerecord] [--replan]`, `aie2e doctor`. Outputs `report.json`, `report.html` with screenshots, per-test folders, recordings, plans.

### Local UI (PROPOSED, the main gap found in the first real runs)

Problems I hit: runs were headless by default so **I could not see the browser**; in headed mode **there was no visible cursor** (automation moves no OS cursor); results were only files and terminal text, with no links or live progress.

Fixes:

1. **Visible cursor + click ripple** injected into every page (`browser/cursor.js`, `AIE2E_SHOW_CURSOR`, default on). **Done**, tested with a real Stagehand click. It also appears in screenshots and the demo GIF.
2. `aie2e ui` starts a local server and opens the browser UI:
   - **New run form:** URL, description, optional goal, expectations, model, concurrency, cache toggles. Starts a run through the same pipeline as the CLI.
   - **Live run view:** pipeline phases (crawl → plan → run → report), one tile per test with status, step list, token counter, and a **live browser view** (CDP screencast frames over SSE, cursor visible). Stop button (AbortController through the runner).
   - **Results view:** verdict and per-check evidence for each test (including "vacuous" and "claim ≠ evidence" badges), screenshots gallery, heals with old/new selector, replay vs agent mode, token/cost totals.
   - **Links everywhere:** HTML report, `report.json`, each screenshot, recording JSON, plan JSON; "open in folder"; run history with filters; compare two runs (flaky tests, speed/cost of agent vs replay).
   - **Recordings page:** list recordings, view steps, delete/re-record one test.
3. Architecture: **event bus first.** The pipeline emits typed `RunEvent`s (`phase`, `test.started`, `step`, `screenshot`, `verdict`, `heal`, `done`, `error`). The CLI prints them, the JSON/HTML reporters consume them, the UI server streams them as SSE. UI code never reaches into pipeline internals.
4. Same layer discipline as my other project: `ui/screens → features → primitives`; `server → core`; `core` knows nothing about React or HTTP.

### Demo story for the interview (what the final run must show)

1. `aie2e ui` → paste my AI Presentation Builder URL → watch the agent (cursor visible) plan and run 4–5 flows in parallel.
2. Run again → **replay**: seconds instead of a minute, **0 tokens**.
3. Break a selector (or ship a changed UI) → **self-heal** shown in the report with old/new selector.
4. A deliberately wrong expectation → the judge **fails** it and flags **agent claim ≠ evidence**.
5. Seeded-bug demo app → detection-rate table (§8b).

---

## 6. Code organization

```
src/
  core/        types.js (Zod), ports.js, graph.js, pipeline.js, testRunner.js      ← no browser/HTTP/React
  config/      config.js (Zod, env AIE2E_*, precedence: CLI > env > defaults)
  browser/     session.js (Stagehand + Playwright CDP, evidence), chrome.js, cursor.js
  crawler/     bfsCrawler.js, noopCrawler.js
  planner/     llmPlanner.js, staticPlanner.js, cachedPlanner.js
  executor/    agentExecutor.js, replayExecutor.js, cachingExecutor.js, steps.js
  judge/       evidenceJudge.js
  llm/         aiSdkLlm.js
  reporter/    jsonReporter.js, htmlReporter.js, compositeReporter.js
  storage/     artifacts.js, recordStore.js
  cli/         main.js
  util/        logger.js, misc.js
  (new)  events/  runEvents.js (typed bus)      server/  fastify app, SSE, screencast      ui/  Vite React app
tests/         unit + integration/ (local test app, fake agent, mock LLM, real Chromium)
docs/          ARCHITECTURE.md, KICKOFF.md, DECISIONS.md, TRADEOFFS.md, diagrams/*.mmd|png
examples/      demo apps for evaluation (incl. a seeded-bug app)
```

**Import direction:** `cli | server → core → ports`; adapters (`browser`, `crawler`, `planner`, `executor`, `judge`, `reporter`, `storage`, `llm`) depend on `core/types|ports` only; `core` never imports an adapter. No React or HTTP in `core`.

---

## 7. Lessons from the first real runs (carry these over)

1. **Stagehand 3.7.3 pinned; agent callbacks (`onEvidence`) need `experimental: true` + `disableAPI: true`** in the constructor. `thinkingEffort` is only read from the object form `agent({ model:{ modelName, thinkingEffort } })`.
2. **`anthropic/claude-haiku-5-5` breaks the agent loop** ("Invalid `signature` in `thinking` block … bound to a different conversation"): Stagehand 3.7.3 doesn't know the model, so it can't disable its default thinking, and its loop edits earlier messages. Use `claude-haiku-4-5`. Also remember the user's `.env` overrides code defaults.
3. Playwright's default headless shell may not be installed on my machine. `chrome.js` resolves **one browser for every component**: `AIE2E_CHROME_PATH` > Playwright Chromium > installed Chrome/Edge.
4. As root/containers Chromium needs `--no-sandbox` (`AIE2E_CHROME_ARGS`). The sandbox Chromium is `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`.
5. A script injected into every page **must never throw** (my first cursor script produced a `pageerror`, which the strict judge correctly counted as a console error; the integration suite caught it).
6. Weak planner expectations were the biggest source of false results (generic words, hostnames, over-specific visual questions). Fix the planner prompt and the judge's vacuity rule, not the app.
7. AI-planned runs cost ≈ **$0.40 for 5 tests** on Haiku 4.5 (375k input tokens, mostly screenshots), 27–62 s per agent test. Replay should cut both to ≈ 0.
8. **File sync to my machine is flaky:** after `device_commit_files`, always verify sizes with `device_list_dir`; if a size is stale, commit again (it landed on the second try several times).
9. Stale `.ts` files from the first scaffold remain on my disk (`src/**/*.ts`, `tests/*.ts`, `tsconfig*.json`, `vitest.config.ts`); I must delete them. Don't reintroduce TypeScript.
10. `npm run dev` is `node --watch` and just prints help; use `npm start -- run …`.

---

## 8. References (credit in README; ideas only, no copied code)

Flowtrace (link TODO), Playwright Test Agents (planner/generator/healer), Magnitude, Octomind (record + self-heal). Libraries: Stagehand (MIT), Playwright (Apache-2.0), Vercel AI SDK (Apache-2.0), Zod (MIT), Commander (MIT), Vitest (MIT), LangGraph JS (MIT, if adopted), Fastify (MIT, if the UI is built). Verify each licence string before listing.

### 8b. Quality, safety nets, evaluation

1. **Evaluation table (README centrepiece).** Run on 3 apps: my AI Presentation Builder, a public TodoMVC, and a **seeded-bug app** (`examples/buggy-shop`: known injected bugs such as a broken button, wrong total, console error, failing request, missing validation). Report per app: tests planned / passed / failed, **bugs detected vs seeded**, **false positives**, **repeatability** (3 runs), time, tokens/cost, agent vs replay.
2. **Honesty tests** (already working): goal the app can't satisfy → judge FAIL + `AGENT CLAIM MISMATCH`.
3. **Judge unit/integration tests** are the safety net; run them before every handoff (`npm run check && npm run lint && npm test`).
4. **CI**: GitHub Action that runs `aie2e run` against a URL and uploads `report.html`; exit code gates the job. (Replays in CI cost nothing, which is the point.)
5. **Should-have:** export a recording as a plain Playwright `.spec.js` (deterministic CI test, no LLM at all).

---

## 9. Scope and priorities (updated Thu 29 Oct, 23:15)

Full plan and designs: [docs/ROADMAP.md](ROADMAP.md).

**Vision (29 Oct night):** test the REAL app in real time (the interviewer's team only has mock-data
Playwright suites); users author their own tests and flows; **theme conformance of the production build**
(the themes the app ships as CSS variables must be applied everywhere, in every theme, on every state the
agent reaches); proper visual testing; an optional attribute contract in client code.

| Day | Scope                                                                                                                                                                                                                                                                                                                                                                                                       | Status   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Thu | repo, agent loop, judge, planner, crawler, parallel runs, reports, record/replay/heal, cursor, **local UI** (live screencast, results, dark mode, viewer), quality evidence (API, vitals, a11y, downloads, toasts), app hints, **LangGraph**, **seeded-bug shop + evaluation (10/10, 0 false positives)**, committed suites + export, CI e2e job, **theme conformance v1** (moved up from Fri), study guide | **done** |
| Fri | Theme audit on every agent-reached state + cross-page consistency; `text-visible` ignores hidden copies; first real run on my Presentation Builder (light/dark) + fixes; rehearse the demo story (replay at 0 tokens, forced heal, wrong expectation)                                                                                                                                                       | next     |
| Sat | Visual baselines per theme (pixel diff + `data-aie2e-mask` + approve; AI triage if time), test case manager in the UI, login flows (credentials + saved session)                                                                                                                                                                                                                                            |          |
| Sun | Attribute types `.d.ts`, reusable GitHub Action, TodoMVC run, diagrams refresh, CLAUDE.md / DECISIONS.md / TRADEOFFS.md, README, static showcase (optional)                                                                                                                                                                                                                                                 |          |
| Mon | Final evaluation runs, demo GIF, one final run only. **No new features.**                                                                                                                                                                                                                                                                                                                                   |          |

**Cut order if behind:** reference-site/Figma comparison → Playwright spec export → MCP server → AI diff triage.
**Never cut:** strict judge, record/replay/heal, the live view with visible cursor, theme conformance v1, the
evaluation table, the README with honest limits.

Out of scope (roadmap): hosted service and accounts, API/backend test generation, schedules, run video,
Figma Variables sync (Enterprise-only API).

---

## 10. Docs and repo hygiene

- Fresh repo; commit per meaningful step, Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). History is graded.
- `README.md`: what/why, 60-second quick start, architecture diagram, the record/replay/heal story, strict-judge rules, evaluation table, CLI + UI reference, env vars, honest known-gaps, credits and licences.
- `docs/ARCHITECTURE.md` (exists, keep current), `docs/DECISIONS.md` (numbered decisions D1…; mark superseded ones), `docs/TRADEOFFS.md` (alternatives not built and why: Stagehand v4, TypeScript, hosted DB, Magnitude/Playwright-agents as engines, screenshot-diff judge, trusting agent claims, auto-heal that rewrites expectations…).
- `CLAUDE.md`: concise version of this file for future AI sessions, with a "current status" section kept up to date.
- Keep AI chat transcripts for submission.

---

## 11. How I want to work with you

- Complete, runnable code per scope item, with file paths; keep the **demo path working at the end of every step**.
- After each step: what to run, what output to expect, and a suggested commit message.
- **Verify before handing over:** `npm run check`, lint, prettier, the full test suite (real Chromium in your sandbox), then commit files to my machine and **verify sizes on disk**.
- Be direct about risks and cut scope early. Flag when something contradicts these decisions instead of silently changing course.
- Check current docs rather than guessing library APIs (Stagehand, Playwright, AI SDK, LangGraph, Fastify). Read the installed source when docs are thin.
- Explain non-obvious code briefly; I must defend it. Prefer simple over clever.

## 12. First tasks for the next session

1. Read this file, `docs/ARCHITECTURE.md` and `src/core/*`; list anything missing or contradictory (briefly).
2. Confirm the **PROPOSED** items with me: local UI stack (Vite + React + Tailwind + shadcn, Fastify + SSE + CDP screencast) and the LangGraph swap plan.
3. Build the **typed run-event bus** (`events/runEvents.js`) and make the CLI printer + reporters consume it. Tests first.
4. Build `aie2e ui` server (start run, SSE stream, static reports/recordings), then the React UI in this order: new-run form → live run view with screencast → results with evidence → run history with links. Stop for my review after each.
5. Then run record → replay → heal on my AI Presentation Builder deployment and fix what breaks.
