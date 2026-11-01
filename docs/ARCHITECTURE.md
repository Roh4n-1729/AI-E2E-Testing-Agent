# Architecture

Given a URL (plus an optional description), the tool plans test cases for user flows, runs them with
AI agents driving a real browser, judges pass/fail from independent evidence, and reports.
It is generalised: nothing in `src/` knows about a specific app.

**Core idea:** agents _author_ and _repair_ tests; plain Playwright _replays_ them. A successful
agent run is recorded as deterministic JSON steps and replayed with zero LLM calls. A failed step
falls back to the agent (self-healing) and updates the cache, and every heal is logged.

## 1. Components

![components](diagrams/01-components.png)

Layers, outermost first:

| Layer             | Path                                   | Rule                                                                |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------- |
| CLI and UI        | `src/cli`, `src/server`, `ui/`         | Parse input, start a run, stream events. No test logic.             |
| Run setup         | `src/app/startRun.js`                  | Config, login once, theme reference, baselines; builds the graph.   |
| Orchestrator      | `src/core/pipeline.js`                 | LangGraph: crawl, plan, runTest (fan-out), writeReport.             |
| Ports             | `src/core/ports.js`                    | Interfaces: Crawler, Planner, Executor, Judge, Reporter, Store.     |
| Adapters          | `crawler/ planner/ executor/ judge/ …` | One implementation per port. Swap without touching the graph.       |
| Browser           | `src/browser/session.js`               | The only place that touches Stagehand and Playwright directly.      |
| Checks            | `src/theme`, `src/visual`, `src/auth`  | Theme audit, consistency, visual baselines, login. Pure evidence.   |
| Domain + contract | `src/core/types.js`                    | Zod schemas are the source of truth for every persisted/JSON shape. |

## 2. Run lifecycle

![lifecycle](diagrams/02-run-lifecycle.png)

Each test gets its own Chromium (isolation first; pooling is an optimisation we skip).
The judge runs even when the executor throws, so a crash is reported with evidence. Tests run in parallel with `--concurrency N` (bounded pool, one Chromium each).

## 3. Record, replay, heal

![record replay heal](diagrams/03-record-replay-heal.png)

Implementation seam: `CachingExecutor` is a **decorator** around `AgentExecutor`
(`Executor` port). It loads a `Recording`, replays with Playwright locators, and on a step failure
calls the wrapped agent for that single step. Nothing else in the codebase changes.

Anti-masking rules (these are the point of the project):

1. A heal never changes the verdict. The judge decides on the final evidence, same checks as authoring.
2. If the judge fails after a heal, the cache is **not** updated and the heals are listed as suspect.
3. Every `HealEvent` (old selector, new selector, reason) is in the report.
4. A recording is invalidated when its fingerprint (goal + startUrl + expectations) changes.
5. **A recording is kept only if it replays** (D36, `TestRunner.#replayOnce`, `AIE2E_VERIFY_RECORDINGS`). Right
   after the judge passes an agent run, its steps are replayed once in a fresh browser with no AI and judged on
   the test's own checks (no quality or screenshot gates, so it stays quick; visual questions are asked again).
   A recording that fails is not saved; the test still passed, and the report says it could not be recorded.
6. **Sturdier selectors** (D37). Stagehand records absolute XPaths (`/html[1]/body[1]/div[1]/main[1]/…`) that break
   when one wrapper is added. A step's element gets, in order: its test id, a close ancestor's test id, a real
   `#id` (ids a framework makes up, like React's `_r_e_` or `radix-…`, are skipped), or its role and accessible
   name (`internal:role=button[name="Generate"s]`, only when unique, short and the same element). The agent run
   tries this right after each action; when the click already changed the page, the replay check above does it
   just before replaying that step, and the replay uses it, so the saved recording is the one that worked. The
   XPath always stays as a fallback.

### Judge rules added after the first real runs (29 Oct)

- **Vacuous expectations do not count.** The harness snapshots the start page before the agent acts
  (`BrowserSession.baseline`). An expectation already true there is marked `vacuous`; a goal test
  needs at least one non-vacuous passing outcome check, else it fails as "Inconclusive". This caught
  planner expectations such as `url includes "presentation"` (matched the hostname) and generic words.
- **Recordings are written only by runs the judge passed.** A replay that completes but fails the judge is
  re-checked by the agent from scratch; if the agent also fails the judge the failure stands (no masking).
- **Plans are cached** (`planner/cachedPlanner.js`) so test ids stay stable and recordings can hit.

## 4. The strict judge

The agent says "done" and may be wrong. The judge never reads that claim for the verdict. The
harness collects evidence through Playwright, a driver the agent does not control: final URL,
aria snapshot, visible text, console errors, failed network requests, and screenshots. Expectations
are checked against that. `TestResult.claimMismatch` flags any disagreement between claim and
verdict, which is itself a signal worth showing in the report.

`visual` expectations ask an LLM a yes/no question about a screenshot the **harness** takes at
judging time, never the agent's own frames. With no LLM available the check fails loudly instead of
passing silently. `LlmPlanner` always emits a deterministic smoke test first, then up to
`--max-tests` AI-planned flows grounded in the crawl summary. Planner failures abort the run
instead of silently degrading.

## 4b. Quality evidence and live view (29 Oct, evening)

Found by running on a real app: all three failures of the 12:47 run were bad _test specs_, not bad agent
behaviour (planner-guessed URL fragments `/presentation`, `slideshow`, `download`; and a download toast that
had vanished before the end-of-test screenshot). So the judge got more independent senses, and the planner
less room to guess.

| Signal                                                                    | Where                   | How the judge uses it                                                  |
| ------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| fetch/XHR log (method, url, status, duration, bytes)                      | `browser/collectors.js` | `api-call` expectation; slow-API warning; request totals in the report |
| File downloads (Playwright `download` event, saved under the test folder) | collectors              | `download` expectation (name/extension)                                |
| Transient messages (MutationObserver on toasts / alerts / live regions)   | collectors              | `text-appeared` expectation, true even if the toast is gone at the end |
| Core Web Vitals (Google `web-vitals`: LCP, CLS, INP, FCP, TTFB)           | collectors              | `web-vitals` budgets                                                   |
| Accessibility (axe-core, WCAG 2.x A/AA) on the final page                 | collectors              | `no-a11y-violations` (min impact)                                      |

- **Quality gate** (`--quality off|warn|fail`, UI select, `AIE2E_QUALITY_GATE`): Web Vitals + accessibility run on
  every test. `warn` (default) marks the checks _advisory_: shown, never change the verdict. `fail` makes a breach
  fail the test. Budgets default to Google's "poor" thresholds so only clear problems trip.
- **Vacuity applies to API calls too**: a matching request already made before the agent acted proves nothing.
- **Planner grounding**: `url-contains` and `api-call` are kept only if the value appears in the crawl (links, or
  API calls seen on load); otherwise dropped and logged. If nothing is left, a visual question about the goal is used.
- **Hover-revealed controls**: the agent has a `hoverAt(xPercent, yPercent)` tool (real pointer movement). It is
  recorded as a `mouse` step with viewport percentages, so replay works at any window size.
- **Cursor**: eased glide (distance-scaled, rAF) instead of jumping; last position kept across navigations.
- **Live view**: CDP `Page.startScreencast` (JPEG pushed on every repaint, capped at 30 fps, only while a viewer is
  connected; follows the front tab; idle pages re-sent every ~1.5 s) instead of polling screenshots at 4 fps.

Not covered yet (be honest in the README): cross-browser, mobile viewports, visual regression baselines,
authenticated flows, load/security testing, exploratory "does this feel right" judgement.

## 4c. Judging rules added from the 13:19 run, app hints, libraries

Each rule came from a real run that passed or failed for the wrong reason first.

- **Visual checks see a timeline** (start, up to 3 run frames, now), never a single screenshot.
- **Asymmetric trust:** a success claim is never trusted; a failure claim is believed unless deterministic
  evidence (URL, text, test id, API call, download, toast) contradicts it.
- **Settle before evidence:** start screenshots only after the page renders; final evidence only after the app
  goes quiet (text stable, no `aria-busy`, no fetch/XHR in flight).
- **Heals are labelled by the judge**, not by the agent.
- **Optional app hints** (README, "Optional app hints"): test ids become recorded selectors with XPath fallback.
- **Run log (`trace`)**: every agent or replay step with the screenshot taken after it, rendered as the step
  timeline in the UI and the HTML report.
- **Per-role models:** `AIE2E_PLANNER_MODEL` / `AIE2E_JUDGE_MODEL`; planner and judge tokens reported as overhead.

### Libraries (all open source)

| Job                                    | Library                                                                               | Why this one                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser agent                          | Stagehand 3.7.3 (MIT)                                                                 | Best JS option with DOM-mode act/observe/agent and evidence callbacks. Browser Use is Python, Magnitude is vision-first and less mature in JS.   |
| Deterministic driver, replay, evidence | Playwright 1.64 (Apache-2.0)                                                          | The standard.                                                                                                                                    |
| Structured LLM calls                   | Vercel AI SDK 5 (Apache-2.0)                                                          | Provider-neutral, zod schemas.                                                                                                                   |
| Accessibility                          | axe-core (MPL-2.0)                                                                    | The de-facto engine (also inside Lighthouse).                                                                                                    |
| Web Vitals                             | web-vitals (Apache-2.0)                                                               | Google's reference implementation.                                                                                                               |
| Orchestration                          | LangGraph JS 1.5.3 (MIT)                                                              | `StateGraph` + `Annotation` + `Send` fan-out (§4d). Concurrency capped by our own limiter (LangGraph's `maxConcurrency: 1` drops Send branches). |
| Server                                 | Fastify 5 + @fastify/static (MIT)                                                     | Fast, schema-friendly, SSE via raw reply.                                                                                                        |
| UI                                     | React 19, Tailwind v4, Radix UI, lucide, sonner, yet-another-react-lightbox (all MIT) | The shadcn approach without the generator: accessible primitives, our tokens.                                                                    |
| Validation, CLI                        | zod 4, commander (MIT)                                                                |                                                                                                                                                  |

Considered and not used (yet): Lighthouse (heavier than needed when web-vitals and axe already cover it),
pixelmatch for deterministic before/after diffs (roadmap), Playwright `recordVideo` (not available on a
CDP-attached context; the screencast and step screenshots cover it).

## 4d. LangGraph, suites and evaluation (29 Oct, night)

```
START → crawl → plan ──Send(test)──▶ runTest (× N, `concurrency` at a time) → writeReport → END
                  └──── no tests ─────────────────────────────────────────────▶ writeReport
```

- `core/pipeline.js` builds a real `@langchain/langgraph` `StateGraph`. `results` uses an append reducer, so the
  parallel branches merge, and the report sorts back into plan order. `npm run graph` exports the Mermaid diagram.
- `planner/suitePlanner.js`: committed suites (relative URLs, optional recorded steps → seeded recordings;
  saved recordings win so heals persist). `aie2e export <runId>` writes one from a run.
- `--no-heal`: replay failures are verdict "fail" via `outcome.failure`, with no agent involved.
- `examples/buggy-shop` + `scripts/evaluate.js` (`npm run eval`): clean runs, then one bug at a time; results in
  `.aie2e/eval/EVALUATION.md`.

## 4e. Theme conformance on every screen, and consistency (30 Oct)

- `src/theme/states.js`: `stateFingerprint` (in-page) identifies a screen by route, open overlays, landmarks and
  visible test ids, never text. `ThemeStates` is created once per run (`startRun` → `TestRunner` →
  `BrowserSession.open`). It audits each screen once, shares the result across tests (`reusedFrom`), and caps
  fresh audits.
- `BrowserSession.auditState(label)`: replay calls it after every step; the agent calls it on Stagehand's
  `step_observed` event, when the agent is paused. The fingerprint is checked first (cheap). Only a new screen
  is settled and audited, scroll-safe. `collectEvidence` audits the final screen the same way, and
  `evidence.themeStates` lists them all. `evidence.theme` stays the final screen's audit.
- `src/theme/consistency.js`: `analyseConsistency(results)` runs in `writeReport` over each screen once, using the
  component inventory (`ThemeResult.inventory`). It produces `report.consistency`: near-duplicate looks and
  `data-aie2e-component` variants. Advisory; rendered in the run summary (UI) and the HTML report.

## 4f. Visual regression (30 Oct)

- Capture: `BrowserSession.visualCapture(checkpoint)` takes a masked, cursor-free, animation-finished viewport
  screenshot into `<test>/visual/`. Replay captures after every step (`stepCheckpoint` = index + hash). The
  final screen is captured once plus once per theme (`collectEvidence`). Result: `evidence.visual.captures`.
- Compare: `EvidenceJudge` (given a `BaselineStore`) runs `compareCaptures`. Each capture gets a status:
  new / unchanged / changed / size / error. The diff and a baseline copy are written next to the capture. Under
  the visual gate the judge adds a `visual-baseline` check (advisory in warn mode).
- Persist: `TestRunner` saves "new" captures of passing tests as baselines (and everything with
  `--update-baselines`). The server's `POST /api/runs/:id/visual` approves or rejects one screenshot later.
- `summary.visualChanges` / `visualNew` feed the UI and report.

## 4g. Suites in the UI and login (30 Oct)

- `src/server/suites.js` (`SuiteStore`): suite JSON files; the `/api/suites` routes; `from-run` uses
  `suiteFromRun`. `POST /api/runs { suite: name }` resolves the file. The UI screen is `ui/src/screens/Suites.jsx`.
- `src/auth/login.js`: `AuthSchema` (in suites, run options, CLI and server), `performLogin` (Playwright, once per
  run in `startRun`, before the pipeline), `applyStorageState` (cookies + localStorage init script for the
  Stagehand-owned context in `BrowserSession.open`). The crawler gets the state via `newContext({ storageState })`.
  `AgentExecutor.loggedIn` adds "do not log out" to the instruction. `report.auth` records the username, never
  the password.

## 4h. Theme conformance across products (30 Oct)

- `src/theme/reference.js` `captureReference(url)` runs once in `startRun` (like login) and produces a
  `ThemeReference` (themes → resolved colours, lengths and fonts). It reaches the audit via `TestRunner` →
  `BrowserSession.open({ themeReference })` → `auditState` → `auditThemes({ reference })`. In reference mode the
  audit takes tokens from the reference (same theme id, else its base), ignores the target's own `var()` usage,
  marks misses `off-reference`, and audits theme-less targets in their default look.

## 4i. Planner review loop (30 Oct, from the first full-AI evaluations)

The planner is the weakest link, so its output is checked before any test runs (`reviewExpectations` in
`planner/llmPlanner.js`): text checks are compared with what the crawler saw. Start-page text (proves nothing),
wording the crawl never showed (a guess) and URL checks already true at the start are flagged; a changed number in
text the crawl saw ("Cart (2)" vs "Cart (0)") is allowed. Findings go back to the planner for exactly one revision;
what is still wrong is repaired deterministically (dropped, or turned into a yes/no question about the
screenshots). Generator → deterministic critic → one revision: bounded cost, no infinite loops.

Suites from third-party apps declare their noise (`ignore: { network, console }`), and seeded-bug runs in the
evaluation never approve screenshots (`visual.saveNew: false`), so a bug can never become the baseline.

## 4j. Reading a run: insights and UI v2 (30 Oct)

```
report.json ──▶ reporter/insights.js (pure, no LLM) ──▶ web UI summary + journey
                 headline, findings, per-test outcome     report.html verdict + findings
                 and page flow, checks in words           run list headline
```

`runInsights(report)` derives everything a non-developer reads from the judge's own checks: a headline, findings
grouped by what they mean (tests stuck on the same page are one finding; console and network errors are grouped by
message across tests; visual changes, AI-claim disagreements and heals are "review" or "low", never hidden), and
per test the pages it went through (from the trace URLs, plus the expected pages it never reached), the step that
broke and any error the page itself shows. Checks are said by their `label` when they have one (D28). Nothing in
it can change a verdict (D27). The UI shows the summary first and keeps the developer tabs one click away (D29).

After the verdict, failed tests get one more call (D30): `judge/failureExplainer.js` sends the judge's model the
failed checks in words, the steps by page, the final page text, console errors, failed requests and up to three
screenshots, and stores `result.explanation` (cause, category, confidence, evidence, suggestion). Insights attach
it to the matching finding; the UI and `report.html` show it as "AI's reading". The order is the guarantee: the
verdict exists before the explainer is asked.

### Where AI is used, and where it is not

| Uses a model                                   | Never uses a model                                       |
| ---------------------------------------------- | -------------------------------------------------------- |
| Planner (tests and checks, one revision)       | Crawler, login, replay                                   |
| Browser agent (first runs, heals)              | Every hard check, vacuity, plan review, heal acceptance  |
| Judge: `visual` questions only                 | Accessibility, Web Vitals, theme audit, pixel comparison |
| Failure explainer: failed tests only, advisory | Insights and report wording (D27)                        |

### Two agent engines (D31)

`config.agentEngine` picks the executor in `startRun`: `AgentExecutor` (Stagehand `agent()`) or
`LoopAgentExecutor` (AI SDK `generateText` with tools, `stopWhen: [stepCountIs(maxSteps), hasToolCall('finish')]`).
Both take the same `(test, session, ctx, resume)` and return the same `ExecutionOutcome`, so replay, healing, the
judge and the reports do not know which one ran. The loop's tools act on `aria-ref` locators from the latest
snapshot and record `locator.normalize()` selectors.

## 4k. Watching a run, and who did what (31 Oct)

- **Live stage.** SSE events carry their time (`at`); the browser frame is coloured by state, the current step
  is laid over it with its actor, and a `test.judging` event (emitted by `testRunner` between the executor and
  the judge) hands the overlay to the judge. `hooks/useFollow.js` keeps the step list and the run log on the
  newest line only while the reader is at the bottom.
- **Run log.** Level filter with counts, "only this test" (logger scope = test id), search, copy, 1000 lines.
- **Inputs per part.** `testInputs(outcome)` stores what the agent was given (model, engine, instruction) and the
  steps Playwright ran with their source (`suite`, `recording`, `agent`, `harness`) on each result
  (`result.inputs`, D33). The journey filters by part; the suite editor is split by part.
- **Saved plans** are keyed by URL, description, planner model, test count and `PLANNER_VERSION` (a hash of the
  planner's instructions); a reused plan is announced (`plan.reused`).

## 4l. Deployment (D34)

```
Render (Docker, 1 CPU / 2 GB)
└─ deploy/serve.js
   ├─ Sauce Demo :4500, buggy shop :4300, TodoMVC :4400   (127.0.0.1 only)
   ├─ copies deploy/seed (baked runs, recordings, plans, baselines) into .aie2e on first start
   ├─ installs the demo apps' suites
   └─ node src/cli/main.js ui --host 0.0.0.0 --port $PORT
        └─ server/access.js: code cookie · host allow-list · no private targets (after DNS)
                             · .env login only on listed apps · ≤ 4 tests, 1 at a time
```

`/healthz` answers before the host check (the platform's probe). Locally nothing changes: the server binds to
127.0.0.1 and refuses to listen elsewhere without `AIE2E_ACCESS_CODE`.

## 4m. Exploring deeper (experimental, D35)

The crawler follows links only, so a screen behind a click (a page a button opens, a wizard step, the state after
"Generate") never reaches the planner, and its tests can only ask visual questions. Every passing test has already
been to such screens. With `--rounds 2` (or 3), the pipeline loops:

```
plan ─▶ runTest ×N ─▶ discover ──(new screens, rounds left)──▶ runTest ×M (round 2) ─▶ discover ─▶ … ─▶ writeReport
                         │
                         └─ each passing, recorded test's final screen: new unless a crawled or discovered screen
                            has its route (ids folded: /deck/:id) and ≥ 60% of its controls (or 70% of its words)
```

- **Discovery** (`core/discovery.js`): from the judge's evidence, never the agent's words. The final screen's
  controls, text boxes, safe links, test ids and API calls are collected by `session.collectEvidence`
  (`evidence.screen`); the steps that reach it are the test's recording, only when its fingerprint matches. A
  screen's identity is its route plus its controls, not its text: eight decks open in one editor are one screen
  (found on the presentation builder, where text-based identity made six). When several tests reach it, the
  shortest recording is kept, because every round-2 test replays it.
- **Round-2 planning** (`LlmPlanner.planFrom`): the planner sees the new screens and plans tests that start on
  one of them. Grounding widens to those screens (their URLs, endpoints and test ids become valid hard checks),
  and the plan review treats the starting screen as the start page, so anything already shown there is rejected.
  `CachedPlanner.planFrom` pins round-2 plans like round-1 plans, refreshing the steps from today's recordings.
- **Rewriting tests that were wrong**: a round-1 test that failed and that the AI's reading blamed on the test
  itself is handed to the round-2 planner with that reading, to rewrite from a screen that shows how (found on
  the presentation builder: "improve a slide with AI" failed because the planner never saw the editor's AI chat
  box; the editor screen shows it). The reading only steers planning; the new test is judged like any other.
- **Reaching a screen by its address** (`reachDirectly`, `probePage`): each new screen's URL is opened in a fresh
  browser (logged in when the run is). If the same screen appears (route and controls), round-2 tests start
  there with no steps to replay, in seconds instead of replaying a whole flow (on the presentation builder,
  generating a deck per test). If not (the state lived only in that test's browser, or the URL redirects), they
  replay the steps. Checked every run, so a saved plan follows what works today.
- **Starting deeper** (`TestCase.prefix`, `startsFrom`, `round`): Playwright replays the prefix with no AI
  (`replayPrefix`), then the agent continues as it does after a heal. The judge's "before" snapshot is taken on
  the starting screen, in the first run and in every replay (`ReplayExecutor` retakes it after the prefix). A
  prefix that no longer works fails the test plainly. Tests without a prefix keep their fingerprints.
- **A stopped run is not a broken app:** the report is marked `stopped`, and tests it cut off are listed as not
  finished instead of "could not run" problems.
- **Off by default, and never on the shared instance:** one round is today's behaviour. Each extra round adds
  planner calls and agent runs, capped at `maxTests` per round and 3 rounds.

The golden-master trap: a planner that sees a screen could turn what it shows (a total, a message) into a check
that it is correct, freezing today's bugs into the tests. It cannot here: everything on the starting screen is
rejected by the review, and the planner never sees the result of the action it plans.

## 4n. Run history and comparison (D38)

Every finished run gets a digest next to its report (`<out>/runs/<id>/digest.json`, a few KB: totals, each test's
result, mode, time and tokens, the problems found), built from the report the first time it is needed. The run
list, comparison and history read digests, never the full reports (often over a megabyte each).

- `reporter/compare.js` (pure): `digestOf(report)`, `previousOf(run, all)` (the latest earlier run of the same app
  and suite, else of the same app with another suite or none, flagged in the UI; stopped runs only when nothing
  else exists) and `compareRuns(now, before)`: fixed, newly failing, still failing, new and removed tests (matched
  by id, then by title, since a re-planned test can get a new id), problems found and gone, and the change in
  time, tokens and tests that now replay with no AI.
- Tests a stop cut off are "not finished", never "newly failing", and are left out when that run is the earlier
  one. Reports written before `report.stopped` existed are recognised by a test stopped before it started.
- Runs of different apps are not compared: they have different tests, so there is nothing to match.
- `GET /api/runs/:id/compare[?with=<runId>]` and `GET /api/runs/:id/history`; the run summary shows "Since the
  last run" with a picker for any other run of the app, and a strip of the app's recent runs.
- Reports carry the suite's name (`report.suite`), so a suite run from the CLI and from the UI compare.
- History lives where the runs live. On Render that disk is wiped by every deploy, so keeping history there means
  a persistent disk with `AIE2E_OUT_DIR` pointed at it (it stops zero-downtime deploys and multiple instances).

## 4o. When the AI's reading blames the test (D39, D40)

- **A second try, right away**: a failed test whose reading says `test-problem` is run once more by the agent,
  with the reading's cause and suggestion in its instruction (`TestContext.hint`, `AIE2E_RETRY_TEST_PROBLEMS`).
  Same checks. A pass on the second try is reported as a "review" finding ("passed on a second try"), never as
  a clean pass; when both fail, the first try and its reading are shown.
- **A better goal** (`judge/goalFixer.js`, `POST /api/runs/:id/tests/:testId/goal-fix`): the judge's model
  proposes a rewritten goal from the reading, the last screen's text boxes and buttons, and the checks, which it
  is told it cannot change. The person edits and saves it to the suite; the test's old steps and recording go,
  so the next run records the new way. Only the goal ever changes: a fixer that could loosen checks would turn
  regressions into passes.
- **Screenshots for round-2 planning**: the planner gets the final screenshot of the test that reached each new
  screen, so a control with only an icon is not invisible to it.

## 4q. Prompt caching (D44)

- `llm/promptCache.js`, `AIE2E_PROMPT_CACHE` (`5m` default, `1h`, `off`); Anthropic models only, others ignore it.
- **Planner, judge, reading of failures** (`AiSdkLlm`): the system prompt goes as a system message with a
  `cache_control` breakpoint, so tools (the output schema) + system are cached. Prompts under the model's minimum
  (512 tokens on the 5.5 models, 1,024 on Sonnet 4.6, 4,096 on Haiku 4.5) are simply not cached, at no cost.
- **Our agent loop**: one top-level `cache_control` (automatic caching). The breakpoint moves to the end of every
  request, and since the loop only appends (it must, for thinking signatures), each step reads the earlier ones
  from the cache.
- **Stagehand's agent** caches its own system prompt; its history is rewritten between steps, so no more is possible.
- **Counting**: Anthropic's `input_tokens` is only the part after the last breakpoint. Every usage figure here is
  all input (not cached + read + written), with `cachedInputTokens` and `cacheWriteTokens` beside it; the run
  summary's AI cost says what share came from the cache.

## 4p. Uploads and human in the loop (D41, D42, D43)

- **File uploads** (`browser/uploads.js`): every test page listens for Playwright's `filechooser` event, so a file
  picker never reaches the system dialog, whoever opened it. The harness picks the first file that fits the
  input's `accept` list, from `AIE2E_UPLOAD_DIR` first, then `assets/uploads` (an image as JPEG and PNG, a PDF,
  CSV, text, JSON), records it in `evidence.uploads` and the live log, and shows it to the agent through
  `harnessStatus`. A picker no file fits is recorded with the reason. A replayed click answers the same way.
- **Asking a person** (`core/humanHelp.js`): both agent engines have an `askForHelp` tool for steps only a human
  can do (a CAPTCHA, a one-time code, a verification email, a real payment, a file with no sample). The test
  pauses (`test.waiting`) until the person answers in the live view ("Done, continue" / "I can't",
  `POST /api/runs/:id/tests/:testId/help`) or in the terminal (Enter / "skip"), or the wait runs out
  (`AIE2E_HELP_WAIT_MS`, 5 minutes). Every request and its answer is in `result.help`.
- **Who can help**: only someone who can act in the test's browser, so only when it is shown. Headless, in CI
  and on the deployed instance the answer is immediate ("nobody can help"), the agent finishes with
  `needs-person`, and the report lists the test under "needs a person": not an app problem, no AI reading, no
  second try. A pass a person helped with is labelled ("a person helped"), reviewed, and never recorded.
- **One window** (`browser/host.js`): with the browser shown, the run uses one Chromium for every test, one at a
  time (`concurrency` forced to 1). Before each test the host opens a fresh tab and closes the old ones, clears
  cookies and permissions, clears the storage of every origin the run visited (`Storage.clearDataForOrigin`),
  and restores the login session. Each test's page listeners are removed when it ends, so the next test hears
  only its own events. Headless runs keep a fresh browser per test. The page keeps the configured size
  (`setViewportSize`) when the window is resized, so layouts, screenshots and the agent's positions do not move.
- **Dragging by position** (`dragAt`, both engines): Stagehand's `act` can only drag one element onto another, and
  crop handles, slider thumbs and resize corners usually have no name in the accessibility tree and nothing to drop
  on. `dragAt` presses, moves in steps and releases between two viewport positions (percent) read off the latest
  screenshot; it is recorded as a `mouse` step with method `drag` and replayed at the same place.

## 5. Data model

![data model](diagrams/04-data-model.png)

## 6. Decisions

The main choices, in short. Every decision, numbered with its reason, and the alternatives that were not
built are in [DESIGN.md](DESIGN.md).

- UI components are hand-written shadcn-style primitives (Tailwind v4 tokens), not generated by the shadcn CLI (no network in the build sandbox). Same look, no generator dependency.

| Decision                                                          | Why                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stagehand pinned to 3.7.3** (`v3-latest`), not v4               | v4 (4.x) has a different `Stagehand.create()` API and no `agent()` export. v3 has `agent()`, `onEvidence`, `connectURL()`. Revisit after the deadline. |
| Stagehand launches Chromium, Playwright attaches (CDP)            | Stagehand v3 has its own page layer. CDP lets deterministic code and evidence collection use real Playwright.                                          |
| LangGraph JS (was a hand-rolled 60-line graph until 29 Oct night) | Recognised in agentic AI work, Send models the per-test fan-out, node functions unchanged by the swap.                                                 |
| Plain JavaScript (ESM) + JSDoc types, checked by `tsc --checkJs`  | No build step or runner (`node src/cli/main.js`). Type errors are still caught by `npm run check` and CI.                                              |
| Zod for config, domain and recordings                             | One definition gives validation and types. Recordings on disk are validated on load.                                                                   |
| Ports and adapters                                                | Each day's work lands behind an interface, so the demo path keeps working.                                                                             |
| Judge is deterministic first, LLM second (`EvidenceJudge`)        | Cheap, reproducible, cannot be talked into a pass.                                                                                                     |

## 7. Open risks

1. **Recording from `agent.execute()`: resolved by reading Stagehand 3.7.3 source (29 Oct).** In DOM
   mode the `act` tool returns `playwrightArguments` = `{selector (XPath), method, arguments,
description}`, surfaced in `AgentResult.actions`; `goto`, `navback` and `wait` carry their own args.
   `executor/steps.js` converts these to `RecordedStep`s. Known limit: if one `act` performs several
   low-level actions only the first is exposed, so that replay can diverge. The judge then fails it and
   the runner re-verifies with the agent (logged as a heal). Still to confirm on a real run.
   Agent runs that use any unreplayable page-changing tool are simply not recorded.
2. Agent opens a new tab: `session.page` is "latest open page"; verify on a real flow.
3. Selectors from `observe()` may be XPath-ish and brittle: acceptable because heal exists, but
   it increases heal frequency on dynamic apps.
4. Running as root or in containers: handled since D23 (the agent's Chrome runs without its sandbox on Linux).

## 8. Day plan mapped to code

| Day | Lands in                                                                                                       | Status                                                    |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Thu | repo, config, graph, `BrowserSession`, `AgentExecutor`, JSON report, screenshots                               | done                                                      |
| Fri | `planner/llmPlanner.js`, visual check in `judge/evidenceJudge.js`, `reporter/htmlReporter.js`, `--concurrency` | done (agent path not yet run with a real key)             |
| Sat | `storage/recordStore.js`, `executor/replayExecutor.js`, `executor/cachingExecutor.js`, self-healing            | built Thu (fake-agent tests pass; real-agent run pending) |
| Sun | `crawler/bfsCrawler.js` (pulled forward to Fri), GitHub Action, `examples/` demo apps                          | crawler done                                              |
| Mon | README polish, demo GIF, one final run                                                                         |                                                           |
