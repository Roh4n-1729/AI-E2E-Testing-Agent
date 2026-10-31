# Whole-project review and learning guide

Review date: 30 October 2026. Scope: current first-party project, including committed code and working-tree changes. All findings below are open; this review does not implement fixes. This is the only repository file created by the review.

## Overall assessment

The separation of planning, execution, independent checks, persistence, and reporting is useful and understandable. The project has working browser integration, useful demo apps, and a meaningful test suite. Its most consequential defects concern false passes: missing evidence can look like success, and evidence from before an action can satisfy checks for that action. Resolve these before adding capabilities or relying on the tool as a release gate.

The documentation's invariants are the review criteria, especially D5–D7, D14, D17–D18, and D30–D31 in DECISIONS.md. Historical plans are not all current specifications: KICKOFF.md, ROADMAP.md, and older ARCHITECTURE.md sections contain superseded statements.

### Evidence labels and priorities

- **Reproduced:** exercised directly against the current implementation using a scripted model, a small browser page, or injected evidence. These checks made no real model calls.
- **Code path confirmed:** a concrete trigger and its handling are visible in the implementation; the entire user journey was not separately reproduced.
- **P1:** threatens trustworthy pass/fail behavior or the main execution path; address first.
- **P2:** material correctness or reliability issue with a narrower trigger.

## Consolidated bug register

| ID  | Priority | Area          | Finding                                                             | Evidence                                          |
| --- | -------- | ------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| R01 | P1       | Judge         | A goal with only guards can pass                                    | Reproduced                                        |
| R02 | P1       | Judge         | Evidence collection failure becomes empty, passing evidence         | Reproduced                                        |
| R03 | P1       | Judge         | A stale successful API call can satisfy a later unsuccessful action | Reproduced                                        |
| R04 | P1       | Loop agent    | Batched tools race on the same browser page                         | Reproduced                                        |
| R05 | P2       | Quality       | Explicit audits can pass without being collected                    | Reproduced and code path confirmed                |
| R06 | P2       | Visual        | Failed comparisons do not fail the visual gate                      | Reproduced                                        |
| R07 | P2       | Downloads     | An unfinished download is counted as successful                     | Reproduced                                        |
| R08 | P2       | Judge         | A start-page toast can prove a later action                         | Reproduced                                        |
| R09 | P2       | Suites/cache  | Edited or cleared suite steps can be ignored                        | Reproduced                                        |
| R10 | P2       | Export        | Saved suites lose login and other run context                       | Reproduced and code path confirmed                |
| R11 | P2       | Export        | Hash routes disappear and navigation steps retain the old origin    | Reproduced and code path confirmed                |
| R12 | P2       | Live UI       | Setup failures emit no terminal stream event                        | Reproduced                                        |
| R13 | P2       | Cancellation  | Stop does not cancel several active run phases                      | Code path confirmed                               |
| R14 | P2       | Replay        | Loop keyboard steps do not preserve keyboard behavior               | Reproduced                                        |
| R15 | P2       | Loop agent    | Snapshot truncation makes later controls unreachable by ref         | Reproduced                                        |
| R16 | P2       | Themes        | Body-scoped themes are applied to the wrong element                 | Reproduced                                        |
| R17 | P2       | Themes        | Declaration results are incorrectly reused across themes            | Reproduced                                        |
| R18 | P2       | Themes        | Distinct visual states share a theme-audit fingerprint              | Reproduced key collision; reuse confirmed in code |
| R19 | P2       | CI/evaluation | Infrastructure errors count as successful bug detection             | Code path confirmed                               |
| R20 | P2       | Evidence      | A failed healing retry overwrites the retained attempt's ARIA file  | Code path confirmed                               |

### R01 — A goal with only guards can pass

**Location:** src/judge/evidenceJudge.js:200; src/planner/staticPlanner.js.

The inconclusive condition requires outcomeChecks.length > 0. With zero outcome checks, it is false. A test whose goal is “Submit order” and whose expectations are only no-console-errors and no-network-failures returns pass when the agent does nothing or claims success. StaticPlanner creates this shape when a user supplies a goal without --expect-text or --expect-url. The UI also permits it.

**Observed:** status pass, reason “2 check(s) passed”, with only a warning that the goal has no outcome expectation. This contradicts the documented vacuity invariant.

**Fix direction:** every nonempty goal must have at least one non-vacuous passing outcome check. Preserve legitimate page-load smoke tests, whose goal is empty.

**Regression check:** a successful agent claim plus zero outcome checks must fail as inconclusive; a goal-free smoke test may still pass its guards.

### R02 — Evidence collection failure becomes empty, passing evidence

**Location:** src/judge/evidenceJudge.js:109 and emptyEvidence.

collectEvidence errors are caught and replaced with empty console/network arrays. Their guards then report “No console errors” and “No failed requests”. Losing the evidence is indistinguishable from observing a healthy page. This independently affects goal-free smoke tests as well as R01's goal tests.

**Observed:** injecting a collection exception still returned a passing verdict with both guards green.

**Fix direction:** retain the collection failure and produce an error or an explicit inconclusive result. Partial evidence may be reported, but unobserved signals must not be represented as clean.

**Regression check:** make screenshot or evidence collection throw during a smoke test and require a non-passing result with the collection error.

### R03 — Old API success can satisfy a later bad response

**Location:** src/judge/evidenceJudge.js:308 and isVacuous:585.

The API check searches all matching requests for any successful match. Vacuity separately asks whether all matching requests happened before baseline.requestCount. If one old request meets the expectation and any later request matches the URL, the check passes and is no longer vacuous, even when that later request fails the expected status or timing budget.

**Observed:** an old POST /api/orders response of 200 followed by a new response of 500 produced a passing API check. A network guard may independently catch that 500, but cannot fix this API assertion. The same flaw applies to a new 201 when the test requires 200, or a new 200 that exceeds its duration budget; those need not fail a network guard.

**Fix direction:** restrict the requests eligible to satisfy an action's API expectation to those after the baseline boundary, then test their status and duration.

**Regression check:** old 200 plus new wrong-status or over-budget response must not satisfy the expectation.

### R04 — Browser tools execute concurrently

**Location:** src/executor/loopAgentExecutor.js:362–374; installed AI SDK executeTools uses Promise.all over tool calls.

generateText can return several tool calls in one model response. Their handlers share a mutable page, trace, screenshot naming, and recording list without a queue. Model order therefore does not guarantee browser order.

**Observed:** with an input temporarily disabled, a scripted response requested “fill gift”, then “click Submit”. Submit ran first, recorded EMPTY, and the field became gift afterward. The recording order was click, fill. Both operations reported success.

**Fix direction:** serialize page tools in the requested order, including their settling, evidence, and audits. Cover reads and finish as well so they cannot race with pending mutations. Provider settings alone are not a universal enforcement mechanism.

**Regression check:** batch an auto-waiting fill followed by submit and verify both submitted data and recording order.

### R05 — Explicit quality checks can pass without measurement

**Location:** src/browser/session.js:376, 482–508; src/judge/evidenceJudge.js:375–416, 482–485.

Collection follows the global quality gate and switches, while suite expectations are evaluated regardless. With quality off or accessibility disabled, an explicit no-a11y-violations expectation receives no scan and returns true. Theme checks similarly accept absent/error audits. Web Vitals with no measured budget values return true. This also hides collection errors under a fail gate.

**Observed:** the explicit accessibility check returned passed=true with “Accessibility scan was not run”.

**Fix direction:** distinguish “automatic advisory checks disabled” from “explicit test requires this signal”. Collect explicitly requested evidence, and give missing or failed measurements a non-success state. Decide explicitly how inherently unmeasurable metrics such as INP without interaction should be represented.

**Regression check:** combine explicit checks with quality off, a11y disabled, and collector errors; none should claim that the required audit passed without evidence.

### R06 — Visual comparison errors pass

**Location:** src/judge/evidenceJudge.js:459–479; src/visual/check.js.

The visual check fails only changed or size results. Error results, including missing/corrupt baseline files, are excluded from failure. It can report that zero screenshots matched while returning passed=true. A capture failure that returns null can similarly leave a required check with no comparisons.

**Observed:** one comparison with status error returned pass and “0 screenshot(s) match ... (1 could not be compared)”.

**Fix direction:** under an explicit visual-baseline check or fail gate, comparison/capture errors must be non-passing. Keep first-run “new baseline” policy separate from inability to read an approved baseline.

**Regression check:** delete or corrupt an approved baseline and ensure --visual fail cannot go green.

### R07 — Download initiation is mistaken for completion

**Location:** src/browser/collectors.js:141, 200–219; src/judge/evidenceJudge.js:340–358.

The download event starts an async save without registering a completion barrier. The record enters downloads before saveAs and failure finish. The judge accepts any matching record without an error, including one still pending. Network settling does not track download completion. Closing the session can then abort a download after the test was judged successful.

**Observed:** holding saveAs unresolved left a record with only filename, URL, and timestamp; the download expectation passed.

**Fix direction:** track pending/completed/failed downloads and await completion with a bounded deadline before judging them.

**Regression check:** a delayed download that subsequently fails must not pass merely because the download event fired.

### R08 — Initial toasts count as action evidence

**Location:** src/browser/session.js:baseline; src/judge/evidenceJudge.js:360 and isVacuous.

Seen text is collected from navigation onward. The baseline stores a request boundary but no toast/download boundary, and isVacuous does not handle text-appeared. A “Saved” message emitted during page load can prove a later Save goal even if the agent never presses Save. The in-page seen set also suppresses repeat occurrences of the same text, making event chronology harder to recover.

**Observed:** an initial Saved entry in seenText produced a non-vacuous passing outcome check.

**Fix direction:** record observation sequence boundaries before acting and require a new qualifying occurrence. Preserve repeated events when their timing is meaningful.

**Regression check:** an initial toast alone must not prove a goal; a new matching toast after the action should.

### R09 — Suite step changes and clearing can be ignored

**Location:** src/planner/suitePlanner.js:100, 132; src/storage/recordStore.js:testFingerprint; ui/src/screens/Suites.jsx “Clear recorded steps”.

Saved recordings win over suite seeds. The fingerprint includes goal, startUrl, and expectations, but excludes suite steps or a recording version. Editing a selector while leaving those fields unchanged preserves the fingerprint, so the old saved steps run. Clearing steps in the editor also does not invalidate the external recording, despite the UI promising re-recording.

**Observed:** changing the suite selector from #old to #new left the fingerprint unchanged and loaded #old.

**Fix direction:** establish a revision/invalidation policy for authored steps and make the clear action invalidate the associated saved recording. Preserve deliberate heals only when compatible with the current suite revision.

**Regression check:** edit steps, then clear them, with a saved recording present; each requested change must affect execution.

### R10 — Export loses required run context

**Location:** src/planner/suitePlanner.js:143–169; src/server/app.js from-run route; src/cli/main.js export command.

suiteFromRun returns only tests. It drops login configuration, declared ignore patterns, themeFrom, and maxSteps. The UI adds the URL, but restores none of the other context. A suite saved from a logged-in successful run may therefore start logged out or fail previously declared third-party noise. Custom login configuration cannot be reconstructed fully from report.auth, which stores only a summary.

**Observed:** exporting a report with auth returned no auth. The remaining omissions follow directly from the return object and test mapping.

**Fix direction:** preserve non-secret effective run/suite configuration alongside reports and carry it through export. Continue storing credentials only as environment-variable references.

**Regression check:** export and rerun a suite with custom auth, ignores, theme reference, and maxSteps; its effective setup should survive.

### R11 — Exported navigation is not portable

**Location:** src/planner/suitePlanner.js:159–164; src/executor/replayExecutor.js:runStep navigate.

Relative start URLs are built from pathname + search, dropping the hash. A start URL ending /#/cart exports as /, which starts on another route. In addition, recorded navigate steps are copied unchanged, so absolute local/staging URLs remain embedded when the suite is run against a new environment. Replay does not rebase them.

**Observed:** http://app.test/#/cart exported with startUrl /. Absolute navigation preservation is visible in the step-copying code.

**Fix direction:** preserve hashes and rebase same-app navigation steps against the run target. Preserve truly external navigation only by an explicit policy.

**Regression check:** export a hash-routed flow with an internal navigation, run it at another origin, and verify every intended route and origin.

### R12 — Setup errors leave the live screen waiting

**Location:** src/app/startRun.js:147–192 and 285–305; src/server/runManager.js; ui/src/hooks/useRunStream.js; ui/src/screens/RunView.jsx:Live.

Login, suite loading, and reference capture occur before the try/catch that emits run.error. RunManager catches the rejection and updates its internal status, but emits no terminal event. A UI already watching the stream refreshes the run only on state.finished, which requires run.error or run.finished. It can remain on an endless login/progress screen until manually refreshed.

**Observed:** a missing-credentials login failure produced zero terminal events in RunEvents.history.

**Fix direction:** put setup under the run's terminal-event handling or have RunManager emit an exactly-once terminal event for every rejection. Provide terminal state when subscribing after failure too.

**Regression check:** fail login after POST /api/runs returns and require the live UI to display the error and exit running state automatically.

### R13 — Stop does not cancel the full run lifecycle

**Location:** src/core/testRunner.js:49–50; src/app/startRun.js setup and pipeline wiring; src/llm/aiSdkLlm.js; src/executor/loopAgentExecutor.js:generateText.

The signal closes an active test browser and prevents queued tests from starting. It is not propagated into login, crawling, reference capture, planning, model requests, or failure explanation. The explainer checks aborted only before its call. Stop during one of these operations waits for it to finish; a stalled model request can keep RunManager.active occupied indefinitely.

**Fix direction:** propagate one run signal through setup, browsers, model calls, and advisory explanation. Add deadlines and clean up listeners. A deadline race should also cancel the underlying work rather than merely abandon its promise.

**Regression check:** block each phase in turn, press Stop, and require bounded completion and the ability to start another run.

### R14 — Keyboard recordings change the action

**Location:** src/executor/loopAgentExecutor.js:280–286; src/executor/replayExecutor.js:toLocator and press.

The live tool uses page.keyboard.press on the focused element but records an act on selector body. Replay converts unprefixed body to xpath=body, which did not resolve in the reproduction. Even css=body would focus a different target and would not preserve general keyboard behavior.

**Observed:** live Enter submitted a focused input; replay timed out after eight seconds.

**Fix direction:** add a recorded keyboard operation that replays page.keyboard.press. Preserve the focus-establishing actions before it.

**Regression check:** fill/focus an input, use the generic press tool, then replay and verify the same keyboard handler runs.

### R15 — Truncated snapshots cannot be advanced by scrolling

**Location:** src/executor/loopAgentExecutor.js:216–219, 311–317.

The accessibility snapshot includes offscreen content in document order. Cutting the string to 12,000 characters always removes the same tail. Scrolling, the suggested remedy, does not expose later refs. Screenshots can show a missing control, but the interaction tools still require its absent ref on apps without test-id hints.

**Observed:** a bottom button appeared at character 30,331 before and after scrolling to the bottom; it remained outside the model's snapshot.

**Fix direction:** use pagination or scoped snapshots with usable refs and an explicit mechanism for requesting the omitted content.

**Regression check:** operate on a button after a long static list using only the offered tools.

### R16 — Body-scoped themes are applied to html

**Location:** src/theme/discover.js:53–54, 193–196.

Discovery accepts body.dark and body[data-theme=dark], but ThemeSwitch loses the target element. applyTheme always mutates document.documentElement. These body selectors never activate, so the named dark screenshot and audit can actually inspect the light theme.

**Observed:** after applying the discovered dark theme for body.dark, html had class dark, body had no class, and its background remained white.

**Fix direction:** retain the selector's target element in the switch, and snapshot/restore that element too.

**Regression check:** cover html, body, and unqualified theme selectors for classes and attributes.

### R17 — Theme declaration cache hides dark-only violations

**Location:** src/theme/audit.js:306–317, 372–378.

declarationOf caches only element index and category across the entire theme loop. The winning declaration changes when the theme changes. A light-theme var-derived declaration can therefore be reused for a dark hard-coded declaration; usesVar causes the latter to be accepted.

**Observed:** a light button used color-mix with a token; the dark rule replaced it with hard-coded #aabbcc. Both theme scores were 100%, with no findings, although the dark inventory contained #aabbcc.

**Fix direction:** invalidate declaration lookup on theme switches or key it by theme as well. Ensure leak analysis also uses the appropriate theme's declaration.

**Regression check:** change the winning declaration between light and dark, including var-to-literal and literal-to-var transitions.

### R18 — Theme state reuse can suppress a newly introduced bug

**Location:** src/theme/states.js:25–57, 95; src/browser/session.js:auditState.

The fingerprint omits query parameters, style/class changes, and overlay identity beyond its role. States such as /flow?step=one and /flow?step=two, two different dialogs, or a same-route button whose style changes can share a key. The final audit reuses that key too; it does not force fresh measurement of a changed visual state.

**Observed:** changing a button's background produced the identical fingerprint. ThemeStates.visit and auditState then reuse the earlier result for that key.

**Fix direction:** make the cache conservative about materially different states, or validate a visual/style signature before reuse. Retain bounded sampling without claiming an unmeasured state was audited freshly.

**Regression check:** introduce a hard-coded value after the start audit without changing the route or test IDs, and ensure the final audit catches it.

### R19 — Infrastructure failures inflate bug detection

**Location:** .github/workflows/ci.yml:46–69; scripts/evaluate.js:175–185.

The seeded-regression CI steps treat any nonzero CLI exit as “regression detected”, although exit 2 means execution error. A broken browser or login can make the negative test look successful. The evaluation similarly counts any status other than pass for a previously passing test, including error, as a detected bug.

**Fix direction:** require the intended failing assertion and expected test ID, distinguish exit 1 from 2, and classify infrastructure failures separately from detections. Do not count an error as proof that a seeded functional bug was detected.

**Regression check:** intentionally break the browser path during a seeded-bug run; the CI/evaluation must report invalid execution rather than successful detection.

### R20 — Healing retries overwrite retained ARIA evidence

**Location:** src/browser/session.js:480; src/storage/artifacts.js:forTest/writeText; src/core/testRunner.js:#runWithFallback.

Both attempts use the same per-test artifact directory and write aria-final.txt. If the agent's retry also fails, the runner returns the first replay result, but its ariaSnapshotPath now points at the retry's tree. Screenshot numbering avoids this collision for screenshots; the text artifact has no attempt identifier.

**Fix direction:** namespace every attempt's artifacts or give text artifacts unique names, and keep the retained verdict linked to its own evidence.

**Regression check:** make replay and retry finish on visibly different pages, fail both, and confirm the retained result's ARIA file describes the retained replay page.

## Validation and review limits

- Type checking, ESLint, and the production UI build passed in the first review pass.
- Initial default tests: 68 passed, 63 skipped, three local connection-permission failures. Browser detection in tests checks Playwright's installed binary but does not use the product's system-Chrome fallback.
- A subsequent full run explicitly selected installed Chrome and used local browser/loopback access: **125 passed, 9 failed, 0 skipped**, across 33 files (272 seconds). Seven failures were test timeouts; the other two were a cursor-animation timing assertion and a live-frame-count assertion. This full run was not green.
- **All nine previously failing cases passed on a targeted rerun with --maxWorkers=1**, across eight files (251 seconds; 16 unrelated cases skipped by the name filter). This supports resource contention/load sensitivity as the cause of the first run's failures. It does not constitute a new full-suite green run. Default file parallelism launches many browser-heavy tests simultaneously, so the test configuration needs a deliberate browser-resource budget. No configuration was changed.
- Formatting check failed on the existing .github/workflows/ci.yml. CI runs this check, so this is a current delivery blocker even though it does not change runtime behavior. The workflow was left unchanged.
- All custom reproductions used injected evidence or scripted/mock models. No real model calls were made for this review.
- The recorded 12/12 result in EVALUATION.md measures the authored suite/replay path. EVALUATION_AI.md records a different run: 2/6 detected and three clean-app failures. These are different experiments and must not be presented interchangeably.
- Browser isolation resets cookies/storage between tests; it does not reset shared backend data. Data setup/cleanup remains an acknowledged product limitation, not a newly discovered implementation bug.
- Theme auditing samples up to 400 tagged elements, with geometry filtering; it is not exhaustive proof about every rendered element. Fingerprint reuse and caps further bound coverage.
- Real-provider compatibility, costs, and behavior of the current presets were not verified against live APIs. The loop supports the providers implemented by resolveModel and models capable of its required tools/images; “any model” is broader than the implemented guarantee.
- Documentation says plain Playwright suites run against mocks, but Playwright can test a real backend directly. This project's differentiator is AI-assisted planning, authoring, repair, and its evidence/reporting system.
- Historical docs contain outdated “not covered yet” statements about login and visual baselines, which are now implemented. Use current code and DECISIONS.md to resolve these conflicts.

## Suggested repair order

1. Make verdicts trustworthy: R01–R03, then R05–R08. Missing evidence must be distinguishable from negative evidence.
2. Make authored execution reproducible: R04, R09, R14–R15.
3. Preserve run context and evidence: R10–R13, R20.
4. Correct theme measurements: R16–R18.
5. Strengthen evaluation attribution: R19; then rerun both authored-suite and AI evaluations.

## Learning guide: understand the system from end to end

### 1. The main idea

The product automates two jobs: deciding what to test and performing the interactions. It then checks whether the specified result happened. These jobs must remain separate because an agent saying “done” is only a claim.

Example: “Add the lamp to the cart.” The goal tells the executor what to do. An expectation such as “cart quantity is one” tells the judge what to verify. “No console errors” is a guard; it cannot establish that the lamp was added. R01 is the bug that illustrates this distinction.

Interview explanation: “The agent performs the task; an independently implemented checker verifies the stated outcome.” Independent here means a separate collection/checking path, not that the app or model can never influence any observed data.

### 2. Follow one run through the code

    CLI / React form
        -> startRun: configuration, suite, login, theme reference, adapters
        -> LangGraph: crawl -> plan -> runTest branches -> writeReport
        -> TestRunner: execute -> collect/check -> persist passing work -> explain failures
        -> JSON report + HTML report + live events

Read src/app/startRun.js first. It is the composition root: the place that chooses concrete implementations and connects them. The CLI and HTTP server should translate user input into RunOptions; they should not each implement testing logic.

### 3. Ports, adapters, JSDoc, and schemas

A port describes what a component must do, such as executor.execute(test, session, context). An adapter implements it: AgentExecutor, LoopAgentExecutor, or the cache/replay combination. The pipeline can use the port without knowing which agent implementation was selected.

JSDoc plus checkJs checks JavaScript types during development. Zod validates data at runtime when JSON or user input enters the system. Type checking alone cannot validate a file loaded from disk. Read core/ports.js, core/types.js, and config/config.js together.

The boundaries are architectural intentions rather than perfect enforcement: TestRunner imports BrowserSession, and several adapters directly use Playwright. Do not describe the code as having complete framework or browser independence.

### 4. Discovery and test planning

BfsCrawler uses breadth-first search: visit the start page, queue safe same-origin links, and visit them up to depth/page limits. It collects a compact map, not the whole internet and not every possible state of a SPA.

LlmPlanner asks a model for structured goals and checks. Grounding rejects references absent from the crawl. reviewExpectations checks for start-page text and guessed wording, asks for one revision, and repairs remaining weak checks. This bounds cost, but grounding is not proof that the resulting test is useful. An incomplete crawl can remove a valid assertion, and a generic visual fallback is weaker than an exact count or backend effect.

CachedPlanner pins the plan to stabilize test identities across runs. Without stable IDs and definitions, recordings would rarely be reused.

### 5. Browser execution and the two agent engines

BrowserSession launches through Stagehand and attaches Playwright to the same Chromium using CDP, Chrome's automation protocol. The deterministic code can inspect the same page the agent is driving.

Stagehand's agent owns the default action loop. The experimental LoopAgentExecutor instead supplies tools to the AI SDK. The model reads an accessibility tree, chooses an element reference, calls a tool, sees the result, and repeats. A ref identifies an element in the current snapshot; a durable locator is saved for later replay.

The tool loop is a stateful program, even though an LLM chooses its next operation. Ordering, timeouts, cancellation, and partial failures still require normal engineering. R04, R13, and R15 demonstrate that.

### 6. Record, replay, and heal

CachingExecutor wraps another executor. This is the decorator pattern: it adds cache behavior around an existing capability.

- No valid recording: run the agent.
- Valid recording: execute JSON steps using Playwright.
- A replay step fails and healing is enabled: ask the agent to continue from that state.
- Replay finishes but its checks fail: TestRunner may retry the goal from scratch.
- Persist new steps only after the judge passes; record every healing attempt.

A fingerprint hashes a test definition so a changed goal or expected result invalidates old work. R09 shows why all inputs that should invalidate execution need a deliberate version policy.

Replay can use zero agent tokens. It can still call a model when a suite has visual questions, healing occurs, or failure explanations are enabled. Explain that qualification when discussing cost.

### 7. The judge and the two meanings of baseline

The judge compares expectations against observations. Deterministic checks read URL, text, selectors, requests, downloads, and messages. A visual question asks a model about a screenshot timeline.

There are two different baselines:

- The **start-state baseline** records what was already true before execution. It prevents vacuous checks.
- A **visual baseline** is an approved screenshot used for regression comparison across runs.

An assertion already true before the action does not demonstrate the action worked. API and transient-event checks need chronology, not just existence. R03 and R08 are examples.

Pass means required checks established the expected outcome. Fail means observed behavior did not meet the test. Error means execution or measurement could not complete reliably. An advisory warning does not change the verdict. R02, R05, and R06 show why “could not measure” must not become “measured and clean”.

### 8. Quality, theme conformance, and visual regression

These measure different things:

| Capability              | Mechanism                                           | What it tells you                                              |
| ----------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Functional expectations | URL/DOM/events/network                              | Whether the specified effect happened                          |
| Accessibility           | axe-core rules                                      | Which supported accessibility rules found violations           |
| Performance             | web-vitals and request timings                      | Observed user-experience metrics and slow calls                |
| Theme conformance       | CSS variables, computed styles, CDP declarations    | Whether sampled values align with the discovered design tokens |
| Consistency             | Compare component inventories across audited states | Whether similar/named components drift in appearance           |
| Visual regression       | pixelmatch against approved PNGs                    | Whether captured pixels differ beyond configured tolerance     |

CSSOM is the browser's representation of loaded CSS rules. A computed style is the final value on an element. A custom property/token is a reusable input such as --primary. The declaration lookup tries to explain which rule produced a value. Changing theme changes both values and potentially the winning rule; this is why R17 is consequential.

CIEDE2000 compares colors perceptually. Pixelmatch compares rendered pixels. Neither can infer all product intent. A screenshot difference may be an intended redesign; a matching screenshot may still hide a backend bug.

### 9. Login, state, and parallel execution

performLogin fills credentials from environment variables using Playwright, obtains cookies/localStorage, and restores that session per test browser. It avoids putting a password into the agent's instructions. It does not support every authentication mechanism or automatically reset server-side data.

LangGraph's Send creates a branch per test. An append reducer merges results. createLimiter caps how many tests execute at once. Results are sorted back to plan order for the report. Parallel test isolation is separate from sequential tool execution within a single browser: increasing concurrency across browsers does not justify races inside one browser.

### 10. Events, UI, persistence, and reports

RunEvents carries progress. The server streams it using Server-Sent Events; React reduces those events into UI state. High-volume browser frames are kept out of event history. The stored JSON report is the durable outcome; the standalone HTML and insights derive readable presentations from it.

Every run needs exactly one terminal signal, including setup errors and cancellation. Otherwise the UI cannot know that it should stop waiting. R12 explains why event lifecycle design is part of correctness.

Files provide simple inspectable storage: suites, plans, recordings, screenshots, baseline manifests, and run reports. Export should carry enough non-secret context to reproduce the run. Evidence should identify the attempt that produced it. R10–R11 and R20 concern those guarantees.

The failure explainer operates after the verdict. Its category/cause/suggestion is advisory interpretation. Deterministic insights and an AI explanation are different outputs, and the UI should continue making that distinction clear.

### 11. Tests, CI, and evaluation

Unit tests check small components without real browsers. Integration tests exercise real Chromium and local apps, often with scripted models. Scripted models verify orchestration and tool behavior; they do not measure whether a real model will choose good actions.

Seeded-bug evaluation supplies ground truth: first establish clean behavior, then introduce one known bug at a time. A detection should identify a relevant failure or finding. An infrastructure crash is an invalid measurement. Track detection rate, false positives, flakiness, cost, and time separately.

The current suite/replay evaluation and AI exploration evaluation answer different questions. A strong authored suite validates the runner and checks; it does not establish strong autonomous planning. R19 is especially important when reporting results in an interview.

### 12. A practical study sequence

1. Trace one goal through StaticPlanner, TestRunner, and EvidenceJudge. Predict why no errors alone cannot prove success.
2. Trace one recorded test through SuitePlanner, SeededRecordStore, CachingExecutor, and ReplayExecutor.
3. Follow one replay failure into healing and identify who accepts the new recording.
4. Explain the start-state baseline versus the approved screenshot baseline using one example each.
5. Trace one request, toast, and download from the collector to its assertion. Identify the completion/time boundary.
6. Trace a theme from discovery to switching, probing, declaration lookup, and restoration.
7. Follow a live event from RunEvents through SSE to the React reducer; describe the terminal-event rule.
8. Read the evaluation script and explain what a valid detection, false positive, and infrastructure error mean.

If you can explain those eight traces and the failure cases in this register, you can defend the important design decisions without memorizing every line.
