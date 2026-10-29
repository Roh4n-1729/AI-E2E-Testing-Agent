# Study guide: what we built and why

The animated, interactive version is `docs/study-guide.html`, published as the "ai-e2e-agent Field Guide" artifact:
https://claude.ai/artifact/NnhTmLeM3zaquEHyvmC5v6 (republish to this URL; don't create a new one).

**Maintenance rule (for every build session):** when a feature is built or changed, add or update its chapter in
BOTH this file and `docs/study-guide.html` (with an animation or interactive demo where it helps), update "What's
next", and republish the artifact. Keep each chapter in the same shape: what it is → why it exists → how it works →
where in the code → one line to say in an interview.

_Last updated: Fri 30 Oct 2026, after theme audits on every screen and cross-page consistency._

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

## 09 App hints (optional contract)

- Supported attributes:
  - `data-testid`, `data-test`, `data-cy`, `data-qa`: stable recorded selectors with an XPath fallback; replay uses
    whichever appears first.
  - `aria-busy`: settle waits for it.
  - `data-aie2e-hint`: free text for the planner and agent.
  - `data-aie2e-reveal="hover"`: marks hover-only controls.
  - `data-aie2e-ignore-theme`: opts an element out of the theme audit.
  - `data-aie2e-component="PrimaryButton"`: names a component, which must look the same on every screen.
- Apps with test ids give the agent two more tools: `appTestIds` (lists them, hidden ones too) and `useTestId` (acts
  on one exactly).
- Code: `src/browser/hints.js`, docs `docs/APP_HINTS.md`.

## 10 Evaluation

- `examples/buggy-shop` has 11 bugs you can switch on by name: functional, error, accessibility, performance, three
  theme bugs and one consistency bug (`button-drift`).
- `npm run eval` runs the clean app N times, then each bug on its own, so every detection is attributed exactly.
- Result (committed suite, 0 tokens): **11/11 detected · 0 false positives (3 × 7) · 0 flaky.**
- This measures the judge and the replay path. `npm run eval -- --mode explore --heal` measures the full AI path.
- Code: `scripts/evaluate.js`, `docs/EVALUATION.md`.

## 11 UI and live view

- `npm run ui`: a Fastify server with a React 19 UI (Tailwind v4 tokens, Radix, sonner, yet-another-react-lightbox).
- Live view: Chromium → CDP `Page.screencastFrame` → server → Server-Sent Events → UI. Frames are only captured while
  someone watches.
- Run page:
  - summary;
  - a filterable test list;
  - tabs Steps (a timeline with screenshots), Checks, Network, Quality, Theme and Agent (the claim is shown, never
    trusted).
- The standalone `report.html` has the same views with no dependencies.

## 12 Libraries

- **Stagehand 3.7.3:** the AI agent. It is pinned because it can't run claude-haiku-5-5, so the agent uses
  claude-haiku-4-5.
- **Playwright 1.64:** used as a library, not `@playwright/test`.
- **LangGraph JS 1.5.3:** orchestration.
- **Vercel AI SDK + zod:** structured LLM calls.
- **axe-core, web-vitals, culori:** accessibility, Web Vitals and colour difference.
- **Fastify, React 19, Tailwind v4, Radix UI:** server and UI.
- **Vitest:** 85 tests, unit plus real-browser integration.
- **Language:** JavaScript ESM with JSDoc types checked by `tsc`, so there is no build step.

## 13 Lessons from real runs

Full log: `docs/IMPROVEMENTS.md`.

| What we saw                                             | What changed                     |
| ------------------------------------------------------- | -------------------------------- |
| A check passed on text that was already on the page     | vacuity                          |
| A false pass on a "change" question from one screenshot | timeline + asymmetric trust      |
| Blank start screenshots                                 | settle                           |
| A heal was labelled by the agent's own claim            | the judge relabels heals         |
| 1.04M tokens per run                                    | shortest-path rule               |
| The planner guessed URLs                                | grounding                        |
| LangGraph dropped Send branches                         | own limiter                      |
| The judge caught a script-order bug in the demo shop    | fixed in the app, not the tester |
| `.first()` picked a hidden copy of the text             | visible-only text checks         |
| A theme bug lived in a dialog the test closed again     | audit every screen               |

## 14 What's next (deadline Mon 2 Nov)

- **Fri:**
  - ~~theme audit on every screen~~, ~~cross-page consistency~~, ~~visible-only text checks~~: done;
  - first real run on the AI Presentation Builder in light and dark, and fixes from it;
  - rehearse the demo story on the real app.
- **Sat:**
  - visual baselines per theme: pixel diff, `data-aie2e-mask`, approve flow, AI triage if time;
  - a test case manager in the UI;
  - login flows.
- **Sun:** typed attribute contract (`.d.ts`), the GitHub Action, a TodoMVC run, the README.
- **Mon:** final evaluation runs and the demo GIF. Nothing new.
- **Cut order:** Figma/reference-site comparison → Playwright spec export → MCP server → AI diff triage.

## Glossary

- **Expectation:** a machine-checkable end-state statement.
- **Vacuous check:** already true at the start, so it proves nothing.
- **Baseline:** the page snapshot taken before the agent acts.
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
