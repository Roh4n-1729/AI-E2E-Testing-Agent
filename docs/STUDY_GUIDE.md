# Study guide: what we built and why

The animated, interactive version is `docs/study-guide.html`, published as the "ai-e2e-agent Field Guide" artifact:
https://claude.ai/artifact/NnhTmLeM3zaquEHyvmC5v6 (republish to this URL; don't create a new one).

**Maintenance rule (for every build session):** when a feature is built or changed, add or update its chapter in
BOTH this file and `docs/study-guide.html` (with an animation or interactive demo where it helps), update "What's
next", and republish the artifact. Keep each chapter in the same shape: what it is → why it exists → how it works →
where in the code → one line to say in an interview.

_Last updated: Fri 30 Oct 2026, after visual regression, test suites in the UI and login flows._

---

## The 30-second version

Teams already have Playwright suites, but they run against mock data. This tool tests the real app in real time.
Give it a URL: it explores the app, writes tests, drives a real browser with an AI agent, and decides pass/fail only
from evidence the agent cannot fake. **AI writes and repairs tests; Playwright replays them.** A separate **judge**
checks the page, URL, network, console and screenshots before anything counts as a pass.

Colour legend in the HTML guide: violet = AI/LLM involved, blue = deterministic (Playwright, no LLM),
green/red/amber = pass/fail/warning.

## 01 The pipeline (orchestration)

- LangGraph state graph: `START → crawl → plan → (Send: one runTest per test) → writeReport → END`.
- `Send` creates parallel branches; each appends its result to shared state through a reducer (`results`). The report
  re-sorts into plan order.
- Parallelism is capped by our own `createLimiter`: LangGraph's `maxConcurrency: 1` silently drops Send branches
  (reproduced in isolation; covered by `tests/pipeline.test.js` at concurrency 1 and 2).
- The node named `report` collided with the state key, so it is `writeReport`.
- Exit codes: 0 all passed, 1 a test failed, 2 an execution error.
- Code: `src/core/pipeline.js`, `src/util/misc.js`, `scripts/graph.js` (`npm run graph` draws the graph from code).
- Interview: "Send for fan-out; found the maxConcurrency bug, reproduced it, replaced it with my own limiter plus a test."

## 02 Crawl (discovery)

- Capped breadth-first crawl, same origin only, skips destructive links (logout, delete).
- Per page: title, headings, buttons, forms, API calls seen, test ids and hints → the site map.
- Why: without a map the planner invented URLs (`/presentation`). Now it may only use what the crawl saw.
- Code: `src/crawler/bfsCrawler.js`.

## 03 Plan (test design)

- An LLM turns the site map + optional description into test cases: a plain-English **goal** (for the agent) and
  **expectations** (for the judge). Alternatives: `--goal "…"` for one flow, or `--suite file.json`.
- Expectation kinds:
  - **Hard (deterministic):** `url`, `text-visible`, `selector-visible`, `api-call`, `download`, `text-appeared`.
  - **Soft (AI reads pixels):** `visual`, a yes/no question answered from a screenshot timeline.
  - **Guards:** `no-console-errors`, `no-network-failures`, `web-vitals`, `no-a11y-violations`, `theme-conformance`.
- Planner rules: prefer hard checks; "change" questions compare before/after; one condition per question; shortest
  path (sample content) unless the test is about creating it; only ground-truth URLs, endpoints and test ids.
- Code: `src/planner/llmPlanner.js`, `suitePlanner.js`, `cachedPlanner.js`.

## 03b Your own tests: suites (added Fri 30 Oct)

- The planner is optional. The **Test suites** page lets people write tests:
  - a title, a start page and a goal in plain English;
  - checks picked from the list of everything the judge supports.
- It saves the same JSON file `--suite` runs in CI (`<outDir>/suites` or `AIE2E_SUITES_DIR` in the repo).
- No goal = a page-load check. A goal = the agent does it once and the passing run is recorded. Recorded steps
  replay with no AI; clear them when the test should do something else.
- **Save as suite** on any finished run keeps its tests and recorded steps. Saving validates and lists problems by
  path instead of writing a broken file.
- Code: `ui/src/screens/Suites.jsx`, `src/server/suites.js`, `src/planner/suitePlanner.js`.

## 04 Run: agent, replay, heal (the key idea)

- No recording → the Stagehand agent drives the browser, and every step is traced with a screenshot.
- Judge passes → the steps are saved as JSON with stable selectors (test id / non-generated id, XPath fallback).
- Next run → **plain Playwright replays the steps, with 0 LLM calls**.
- A replayed step breaks:
  - heal on → the agent continues from the current page, the heal is logged, and the recording is updated;
  - heal off (`--no-heal`, CI) → a plain failure.
- A recording is tied to a **fingerprint** of the test, so editing the test forces re-recording.
- A heal never decides the verdict: the agent's outcome is provisional and the judge overwrites it.
- Code: `src/executor/cachingExecutor.js`, `agentExecutor.js`, `replayExecutor.js`, `steps.js`, `src/storage/recordStore.js`.
- Interview: "Healing can hide regressions, so the judge, not the healer, labels the result."

## 04b Apps behind a login (added Fri 30 Oct)

- **Once per run, before anything else, plain Playwright (no AI):**
  - log in;
  - capture the session (cookies + localStorage, `storageState`);
  - start the crawler and every test with it.
- **Credentials** only come from `.env` (`AIE2E_USERNAME`, `AIE2E_PASSWORD`). They are never in suites or reports,
  and never sent to the AI. A test greps the report for the password.
- **Finds the form itself,** including "email, Next, then password". Unusual logins use `auth.steps` with
  `{{username}}`/`{{password}}`.
- **Success** is checked by text, URL, or by default "password field gone". A failed login stops the run with a
  screenshot.
- **Why not a shared profile:** Chrome locks a profile to one browser and tests run in parallel. Cookies are added
  per test browser, and localStorage is restored by an init script before the app's code runs.
- The agent is told it is logged in and must not log out, because the tests share the session.
- Entry points: `--login-url` (+ success text/URL), the New run form, or a suite's `auth`.
- Code: `src/auth/login.js`, `src/app/startRun.js`, `src/browser/session.js`.

## 05 Settle (timing)

- `settle(page, {maxMs, quietMs}, inflight)` polls every 150 ms. It returns once all of these hold for a full quiet
  window:
  - the URL and the visible text length are unchanged;
  - no element has `aria-busy="true"`;
  - no fetch/XHR is in flight;
  - the page isn't empty.
- Where it's used:
  - after navigation (8 s cap, 0.5 s quiet), which fixed blank start screenshots (6 of 9 had been blank);
  - before final evidence (15 s cap, 1 s quiet), for streaming AI apps;
  - between replay steps.
- Code: `src/browser/settle.js`, `src/browser/session.js`.

## 06 The strict judge

- It is our own code. Evidence comes from the harness: final URL, the live DOM via Playwright, network, console,
  downloads, toasts, screenshots. Only `visual` checks call an LLM (a timeline of start + up to 3 frames + now).
- Rules:
  1. **Never trust a success claim.**
  2. **Vacuity:** a check already true at the baseline isn't counted. If no outcome check is truly earned, the test
     fails as _Inconclusive_.
  3. **Asymmetric trust:** if the agent says it failed and the only success proof is visual (AI), the test fails.
     Hard evidence (URL, text, test id, API call, download, toast) overrides the agent.
  4. A crash is **error**, not **fail**. A replay break with healing off is `outcome.failure` → **fail**.
  5. **Visible matches only:** `text-visible` and `selector-visible` ignore hidden copies of the text
     (`filter({ visible: true })`). Without this, a hidden copy that comes first in the DOM made a visible
     "Order placed" fail.
- Quality gate `off | warn | fail` auto-adds web-vitals, a11y and theme-conformance checks. In `warn` they are
  advisory (shown as warnings, verdict unchanged).
- Code: `src/judge/evidenceJudge.js` (`HARD_KINDS`, `GUARD_KINDS`), `src/core/testRunner.js`.
- Interview: "A false pass hides a regression; a false fail costs a minute of review. So the judge is asymmetric."

## 07 Quality evidence

| Signal              | Captured by                        | Catches                                |
| ------------------- | ---------------------------------- | -------------------------------------- |
| API calls + timing  | Playwright request/response        | slow endpoints, 5xx, fake success      |
| Console/page errors | Playwright `console` / `pageerror` | uncaught exceptions                    |
| Downloads           | Playwright `download` (incl. blob) | export buttons that do nothing         |
| Transient toasts    | MutationObserver of appeared text  | "Saved!" gone before the screenshot    |
| Core Web Vitals     | `web-vitals` in page               | LCP/CLS/INP/FCP/TTFB budgets           |
| Accessibility       | `axe-core` in page                 | alt text, contrast, nested interactive |
| Theme conformance   | chapter 08                         | hard-coded values, dark-mode leaks     |
| Consistency         | chapter 08 (run level)             | the same button in two shades of blue  |

Code: `src/browser/collectors.js`, `session.js#collectEvidence`, `src/config/config.js`.

## 08 Theme conformance

The source of truth is the app's production build (CSS custom properties), not Figma. The audit runs in six steps:

1. **Discover:** read the CSSOM for variables on `:root`, `.dark`, `[data-theme=…]` and `prefers-color-scheme`. A
   class or attribute rule counts as a theme only if it overrides base variables. That fixed a bug where `.card { --pad }`
   was treated as a theme.
2. **Switch:** change theme the way the app does (class, attribute or emulated media), with transitions frozen, then
   restore exactly afterwards.
3. **Probe:** tag up to 400 elements and resolve each theme's token values.
4. **Match:** colours count as on-theme within CIEDE2000 ΔE ≤ 2.3 (the just-noticeable difference, via culori);
   radii and font sizes are matched against the theme's scale.
5. **Trace:** CDP `CSS.getMatchedStylesForNode` reports the winning declaration.
   - `var(--…)` means derived from the theme, which is fine.
   - An author rule without a variable is **hard-coded**, reported with selector and file:line.
   - No author rule means a **browser default**.
6. **Leaks:** surfaces whose background stays the same while the page background changes, such as a white card in dark
   mode. Contrast is also checked per theme with axe.

The `theme-conformance` check fails when:

- a theme scores below 90%;
- any value is hard-coded or a browser default (unless `allowHardCoded`);
- any surface leaks (unless `allowLeaks`).

A score alone hid single hard-coded values, which is why the hard-coded rule exists. Results show in a Theme tab in
the UI and in the HTML report: a screenshot per theme, element crops and findings. `data-aie2e-ignore-theme` opts an
element out.

### On every screen, not just the last one (added Fri 30 Oct)

- After every replay step and every agent step, the harness fingerprints the screen:
  - the route, with ids normalised;
  - open dialogs, menus and listboxes;
  - the visible landmarks;
  - the visible test ids.
    Text is left out on purpose, because AI apps write new text on every run.
- Only new screens are audited. The cap is 4 per test plus the final screen (`AIE2E_THEME_STATES`). A screen
  another test already audited in the same run is reused (`reusedFrom`).
- This is safe with the agent: Stagehand awaits its `onEvidence` callback, so the agent is paused. In-between
  audits only crop elements already in view and restore the scroll position.
- Why: a theme bug inside a dialog is invisible to a final-only audit once the dialog closes. The test for this is
  exactly that dialog.

### Across products: `--theme-from` (added Fri 30 Oct)

- Read another product's themes once (a design-system site, or the main app), with every token resolved to a
  value. Then check this app against them, theme by theme. Values are compared, not names: `--color-primary`
  and `--brand-primary` can be the same violet.
- The target's own `var()` usage does not count here (its variables might hold another brand's colours). A
  product without any CSS variables is still checked in its default look. Misses are `off-reference`, with the
  nearest reference token.
- Found while building it: the audit's "transparent" test matched any colour ending in 0, so an orange
  `rgb(255, 102, 0)` background was never checked. Only an alpha of 0 is transparent now.

### Consistency across screens (advisory, run level)

- Each audit also records how buttons, links, inputs, headings and named components look in each theme. It skips
  anything hovered, focused or pressed, because that look is momentary.
- At report time, two looks of the same kind of element that differ only slightly are flagged as
  **near-duplicates**: ΔE between 2.3 and 10, radius or padding within 2px, size within 1px. Elements named with
  `data-aie2e-component` must look identical everywhere. Clearly different looks (secondary, outline, large) are
  deliberate variants and are not reported.
- Why: `color-mix(in srgb, var(--color-primary) 88%, black)` is derived from the token, so every single screen is
  "on theme", yet the checkout button is a different blue. Only comparing screens catches that.
- It never fails a test; it shows in the run summary and the report.

Code: `src/theme/discover.js`, `src/theme/audit.js`, `src/theme/states.js`, `src/theme/consistency.js`, tests
`tests/theme.test.js`, `tests/integration/theme.test.js`.
Interview: "I don't guess from the value; I ask the browser which declaration produced it. And because a value can be
on-theme on each screen and still drift, I also compare the same component across screens."

## 08b Visual regression (added Fri 30 Oct)

- **Why:** some bugs change nothing a check can read (a squeezed grid, a shifted icon). Approved screenshots
  (baselines) are compared with every new run, pixel by pixel.
- **Captures** (`BrowserSession.visualCapture`) are separate from the screenshots people look at:
  - animations finished and the caret hidden;
  - the harness cursor hidden;
  - `data-aie2e-mask` areas painted over;
  - live regions (toasts, status, alerts) hidden.
    The final screen is captured once plus once per theme, and each replayed step too (named index + hash of the
    step, so a healed step starts a new baseline).
- **Compare** (`src/visual/compare.js`): pixelmatch, anti-aliasing ignored, tolerance 0.02. It writes a red diff
  image and records the share of pixels changed and the box around the change. Byte-identical files skip decoding.
- **Baselines** (`src/visual/baselines.js`): `<dir>/<host>/<test>/<checkpoint>.png` plus `baselines.json`.
  - Created by a test's first passing run, like recordings.
  - A changed test definition starts new ones.
  - Point `AIE2E_BASELINES_DIR` into the repo to review them in pull requests.
- **Gate:** `--visual warn|fail|off`; `--update-baselines`. Review happens in the Visual tab (baseline / this run /
  difference, Approve or Reject) or via `POST /api/runs/:id/visual`.
- **Lessons:**
  - pixelmatch's default 0.1 missed a 16px→4px grid gap (a light card on white);
  - writing a diff for every screenshot cost 13 s per run (now 3 s);
  - a leftover toast made 1 run in 5 flaky until live regions were hidden. After that, 245/245 comparisons were
    stable.
- Interview: "Visual diffs are only useful if they're stable, so the evaluation measures that too."

## 09 App hints (optional contract)

- Supported attributes:
  - `data-testid`, `data-test`, `data-cy`, `data-qa`: stable recorded selectors with an XPath fallback; replay uses
    whichever appears first.
  - `aria-busy`: settle waits for it.
  - `data-aie2e-hint`: free text for the planner and agent.
  - `data-aie2e-reveal="hover"`: marks hover-only controls.
  - `data-aie2e-ignore-theme`: opts an element out of the theme audit.
  - `data-aie2e-component="PrimaryButton"`: names a component, which must look the same on every screen.
  - `data-aie2e-mask`: painted over in visual comparisons (timestamps, AI-written text).
- Apps with test ids give the agent two more tools: `appTestIds` (lists them, hidden ones too) and `useTestId` (acts
  on one exactly).
- Code: `src/browser/hints.js`, docs `docs/APP_HINTS.md`.

## 10 Evaluation

- `examples/buggy-shop` has 12 bugs you can switch on by name: functional, error, accessibility, performance, three
  theme bugs, one consistency bug (`button-drift`) and one visual-only bug (`cramped-grid`).
- `npm run eval` runs the clean app N times, then each bug on its own, so every detection is attributed exactly.
- Result (committed suite, 0 tokens): **12/12 detected · 0 false positives (3 × 7) · 0 flaky**, plus visual
  stability (screenshot comparisons that drift across the repeated clean runs).
- This measures the judge and the replay path. `npm run eval -- --mode explore --heal` measures the full AI path.
- Code: `scripts/evaluate.js`, `docs/EVALUATION.md`.

### An app we did not write: TodoMVC (added Fri 30 Oct)

- `examples/todomvc` serves the untouched React TodoMVC build (MIT); `npm run todomvc` → http://localhost:4400.
- 6-test suite, replayed with no LLM: 6/6 on the real app. `BUGS=clear-broken` / `BUGS=edit-lost` inject a tiny
  script when the page is served (the build is never edited); each fails exactly the matching test.
- Real finding: the quality gate reports TodoMVC's checkboxes have no accessible label (axe `label`).
- Lesson: "the other todo is visible" also passes when Clear does nothing. Check the effect (exactly one todo:
  `//ul[@data-testid='todo-list'][count(li)=1]`). The judge is only as strict as the expectation.
- Code: `examples/todomvc/`, `tests/integration/todomvc.test.js`.

### A real app with a login: Sauce Demo (added Fri 30 Oct)

- Sauce Labs' demo shop (MIT) built locally; `npm run saucedemo` → http://localhost:4500.
- Bugs depend on who logs in (`AIE2E_USERNAME`, password `secret_sauce`). Record as `standard_user` (6/6), then
  replay as each broken user for 0 tokens: problem_user 1/6, error_user 2/6, visual_user 4/6 with diffs on every
  screen, performance_glitch_user 6/6 with LCP warnings, locked_out_user stops at login.
- **Declared noise:** a suite's `ignore: { network, console }` (or `AIE2E_IGNORE_NETWORK` / `_CONSOLE`) lists
  third-party requests and console messages that should not fail guards (fonts, error reporters). They stay in
  the evidence; the app's own errors still fail.

## 11 UI and live view

- `npm run ui`: a Fastify server with a React 19 UI (Tailwind v4 tokens, Radix, sonner, yet-another-react-lightbox).
- Live view: Chromium → CDP `Page.screencastFrame` → server → Server-Sent Events → UI. Frames are only captured while
  someone watches. Progress cards (Log in, Explore, Plan, Test, Report), the planned tests, what the plan review
  fixed (`plan.review` event) and the pages the crawl found (`site.ready`).
- **Run summary (UI v2, for anyone):** a verdict sentence, four numbers, "What is wrong" cards ranked by severity,
  and a tests table with "What happened" in one line. All of it comes from `reporter/insights.js`, a pure function
  of the report: no LLM, so every sentence traces back to a judge check.
- **Test journey:** the pages the user went through as a flow strip (stuck page in red, pages never reached
  dashed), steps grouped by page with large screenshots, why it failed in one sentence, screens that look
  different with Approve / Keep, and the old developer tabs under "Developer details".
- **Labels:** a check can carry `label`, plain words for the report ("The cart holds 1 product"). The judge ignores
  it. The planner writes one; the suite editor has a field.
- **Developer view:** the original list + tabs layout, one toggle away (remembered per browser).
- The standalone `report.html` shows the same verdict and findings, with no dependencies.

**Interview line:** "The judge decides, the insights module explains. It is deterministic on purpose: a summary
written by an LLM could contradict the verdict, and it would cost tokens on a run that replayed for free."

## 12 Libraries

- **Stagehand 3.7.3:** the AI agent. It is pinned because it can't run claude-haiku-5-5, so the agent uses
  claude-haiku-4-5.
- **Playwright 1.64:** used as a library, not `@playwright/test`.
- **LangGraph JS 1.5.3:** orchestration.
- **Vercel AI SDK + zod:** structured LLM calls.
- **axe-core, web-vitals, culori:** accessibility, Web Vitals and colour difference.
- **pixelmatch 7.2 + pngjs:** visual diffs. Pinned to 7.2 because 8.0 was three weeks old.
- **Fastify, React 19, Tailwind v4, Radix UI:** server and UI.
- **Vitest:** unit plus real-browser integration tests, including the web UI itself.
- **Language:** JavaScript ESM with JSDoc types checked by `tsc`, so there is no build step.

## 13 Lessons from real runs

Full log: `docs/IMPROVEMENTS.md`.

| What we saw                                              | What changed                     |
| -------------------------------------------------------- | -------------------------------- |
| A check passed on text that was already on the page      | vacuity                          |
| A false pass on a "change" question from one screenshot  | timeline + asymmetric trust      |
| Blank start screenshots                                  | settle                           |
| A heal was labelled by the agent's own claim             | the judge relabels heals         |
| 1.04M tokens per run                                     | shortest-path rule               |
| The planner guessed URLs                                 | grounding                        |
| LangGraph dropped Send branches                          | own limiter                      |
| The judge caught a script-order bug in the demo shop     | fixed in the app, not the tester |
| `.first()` picked a hidden copy of the text              | visible-only text checks         |
| A theme bug lived in a dialog the test closed again      | audit every screen               |
| A 16px→4px grid change looked "unchanged"                | strict pixel tolerance (0.02)    |
| A leftover toast made visual runs flaky                  | hide live regions in captures    |
| Hand-written login steps used CSS, replay assumed XPath  | login steps default to CSS       |
| The transparency regex treated orange as transparent     | only alpha 0 is transparent      |
| "Other todo still visible" passed a broken Clear button  | expectations check the effect    |
| First GitHub CI run: every agent test errored            | Linux Chrome without its sandbox |
| Fonts and an error reporter failed every Sauce Demo test | suite-declared `ignore` noise    |
| A bug run approved its own screenshots as the baseline   | only clean runs approve          |
| "Don't invent data" vs "fill the form" with no values    | planner writes test values       |
| AI tests checked "checkout opened", not "both items in"  | check the effect of each action  |
| The planner guessed "Thank you", reused home-page text   | plan review + one revision round |

## 14 What's next (deadline Mon 2 Nov)

- **Thu + Fri (done):** everything in chapters 01 to 13, three demo apps (seeded-bug shop, TodoMVC, Sauce Demo),
  the GitHub Action, the first CI run fixed, decision docs, the demo script (`docs/DEMO.md`), the README pass.
- **Left, Rohan:** push the CI fix and see run #2 green; one full-AI evaluation run; rehearse with `docs/DEMO.md`.
- **Left, Claude:** fix whatever those two runs show; add the AI numbers and "green in CI" to the README.
- **Sun:** demo GIF, buffer. **Mon:** final run, transcripts, submit. Nothing new.
- **Dropped:** the Presentation Builder run (its own AI spends tokens on every test; Sauce Demo covers the
  real-app-with-login case).
- **Cut, and why:** each one is either covered by something we have, or would add risk without changing the demo:

| Cut                       | Why                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Design-token file import  | Themes are read from the production CSS, which works on every app; a token file is an optional extra. |
| AI review of visual diffs | Puts an LLM back into a deterministic check; a human approves or rejects in the UI instead.           |
| Comparing two runs        | Baselines and recordings already carry history; a side-by-side view is presentation, not capability.  |
| Dockerfile                | The GitHub Action and `npm ci` cover CI; a container adds a build to maintain.                        |
| Playwright `.spec` export | Suites already replay with no LLM and run in CI; exporting would create a second format to keep true. |
| MCP server                | Lets other AI tools call ours; nice, but no requirement or demo step needs it.                        |

## Glossary

- **Expectation:** a machine-checkable end-state statement.
- **Vacuous check:** already true at the start, so it proves nothing.
- **Baseline:** the page snapshot taken before the agent acts. (Visual baseline: an approved screenshot, chapter 08b.)
- **Mask:** `data-aie2e-mask`, an area painted over before visual comparison.
- **Settle:** waiting for quiet: URL, text, aria-busy and in-flight requests.
- **Recording:** JSON steps replayed with no LLM.
- **Fingerprint:** a hash of the test definition.
- **Heal:** the agent finishes after a replay step broke; it is logged and judged.
- **Trace:** the run log of steps with screenshots.
- **Quality gate:** `off`, `warn` or `fail`.
- **Advisory check:** a warning that doesn't change the verdict.
- **Send:** LangGraph's parallel branches.
- **Reducer:** how branch results merge.
- **CDP:** Chrome DevTools Protocol.
- **CSSOM:** the browser's model of loaded stylesheets.
- **CIEDE2000 / JND:** a perceptual colour difference; ΔE ≤ 2.3 is about the smallest difference people notice.
