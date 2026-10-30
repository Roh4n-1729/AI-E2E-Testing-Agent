# Improvements log

Every change that came from running the tool on a real app, newest first. Each entry says what we
saw (with the evidence), what changed, and how it is verified. Add to it whenever a real run
teaches us something: it is the honest history of how the judge got stricter.

---

## 2026-10-30 (Friday, 13:15): second full-AI evaluation: the planner needs a reviewer

With the 12:30 fixes the evaluation reported **2/6 detected, 3 tests failing on the clean app**. Every failure was
the planner writing a check that cannot work; the judge was right each time and the agent's claims were true:

| Planned test                  | Planned check                        | Why it cannot work                                    |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Add Mug, T-shirt and Notebook | the three product names are visible  | already on the home page: discarded as vacuous        |
| Subscribe                     | "Thank you" appeared                 | a guess: the app says "Subscribed! Check your inbox." |
| Check out                     | "Coffee Mug" visible after the order | a guess: the confirmation page lists no items         |

The first one was caused by the 12:30 prompt rule ("expect both product names"). Prompt rules alone kept moving
the mistake around, so the fix is in code:

- **Plan review (deterministic):** every text check is compared with what the crawler saw. Text already on the
  start page is flagged (it proves nothing); text the crawl never showed is flagged as a guess, except a changed
  number in text the crawl did see ("Cart (2)" when it saw "Cart (0)", "Total: ₹448" when it saw "Total: ₹0"); a URL
  check that already holds at the start URL is flagged.
- **One revision round:** the planner gets the findings ("In "Subscribe": "Thank you" appears nowhere in the
  crawl: that wording is a guess") and returns the plan again. What is still wrong is repaired mechanically:
  start-page checks dropped, guessed wording replaced by a yes/no question about the screenshots. Never a second
  round, so cost stays bounded (one extra planner call, only when needed).
- The prompt now says it plainly too: start-page text proves nothing; never guess message wording; check counts.
- The crawl keeps 1500 characters of page text instead of 800, so the review sees more of each page.

Tests: `tests/planner.test.js` (review rules, the revision round, the fallback repair, goal-less tests untouched).

---

## 2026-10-30 (Friday, 12:30): the first full-AI evaluation, read line by line

Rohan ran `npm run eval -- --mode explore --heal --runs 1` on six seeded bugs (planner + agent with
`claude-haiku-4-5`, about 1.17M tokens in total). The report said **5/6 detected, 1 false positive**. Reading the
evidence behind every line, the honest result was **3/6, 1 false positive**, and all three problems were ours:

### 1. A seeded bug became the approved screenshot (two false detections)

The first clean run is done by the agent, so the replayed steps' screenshots did not exist yet. The first replay
of "Add multiple products and proceed to checkout" happened in the `dead-button` run, where the Notebook stays
out of the cart, and that test still passed, so its screenshots were approved as the baseline. Every later run
"differed" from a buggy baseline (after step 4, 5.71% of pixels), and the evaluation credited that warning as
detecting `wrong-total` and `no-validation`.

Fix: runs with a seeded bug never approve screenshots (`freezeBaselines`, config `visual.saveNew`), and explore
mode always does two clean runs (the first records, the second approves the replay screenshots). Test:
`tests/integration/buggyShop.test.js`.

### 2. Our own prompts contradicted each other (the false positive)

The planner wrote "fill in the Name, Email and Address fields" with no values; the agent's instruction said "do
not invent data you were not given". The agent honestly stopped and said so, and the judge failed the test,
which is the strict judge working. Fix: the planner writes the test values into the goal, and the agent uses
obviously fake test data when none is given (never passwords or card numbers) and says what it used.

### 3. AI-planned checks were too weak (one bug missed)

"Add the Coffee Mug and Notebook, then check out" only checked that checkout opened, so the dead Notebook button
went unnoticed; no planned test checked the total or submitted an empty email. Fix: the planner must check the
effect of every action (both product names or the matching count in the cart; the number an action changes).

### What it confirms

Genuine detections: `fake-subscribe` (the 500 behind "Subscribed"), `console-error` (three tests), `dark-leak`
(theme audit with the CSS rule). Replay and healing worked on real AI recordings, the agent never claimed a
success it did not have (0 claim mismatches), and later runs cost 28k to 112k tokens instead of 395k because
they replayed. The reviewed suite still catches 12/12: AI-planned tests are a draft to review, not a finished suite.

---

## 2026-10-30 (Friday, late morning): Sauce Demo, and declared third-party noise

### Why

Testing the AI path on the Presentation Builder spends that app's own tokens on every run. Sauce Labs' demo shop
is open source (MIT), so it now runs locally from a build of its unmodified source: a real app we did not
write, with a login, whose bugs are switched by the user you log in as.

### Results (committed suite, 0 tokens)

standard_user 6/6; problem_user 1/6; error_user 2/6; visual_user 4/6 (plus diffs on every screen);
performance_glitch_user 6/6 with LCP warnings; locked_out_user stops at login. Details in `docs/EVALUATION.md`.

### Found while building it

- **Third-party noise failed every test.** Google Fonts (blocked offline), the Backtrace error reporter with the
  upstream placeholder token, and the Backtrace SDK's deprecated `unload` handler. The judge was right to see them,
  but they are not this app's bugs. New: a suite's `ignore: { network, console }` (regexes) and
  `AIE2E_IGNORE_NETWORK` / `AIE2E_IGNORE_CONSOLE`. Ignored requests stay in the evidence and the run logs what was
  declared; nothing is ignored silently. `error_user`'s own JavaScript errors still fail tests.
- **The UI suite editor would have dropped `ignore` on save** (its `tidy()` keeps only known fields). Fixed.
- The `unload` violation appeared on `127.0.0.1` but not on `localhost`: Chrome's deprecation rollout differs by
  origin. Declaring it in the suite makes both behave the same.

### Verified

`tests/integration/saucedemo.test.js` (standard 6/6, problem_user fails the photo, sort and order tests, locked-out
stops at login, the password appears nowhere in the report); unit test for the env lists; CI step.

---

## 2026-10-30 (Friday, 11:00): first CI run on GitHub, all three jobs red

### What we saw

Run #1 on GitHub: the check job exited 1, both e2e jobs exited 2 (2 = tests errored, not failed), and the
report upload found no files. Reproduced in a clean copy with a fresh `npm ci`: types, lint, prettier and the UI
build all pass; every browser test errors with `waiting for dynamic debugging port in chrome-err.log`.

### Cause

Two bugs, neither in the test logic:

1. **Chrome never started on Linux CI.** Playwright launches Chromium with `--no-sandbox` by default
   (`chromiumSandbox: false`); Stagehand launches Chrome itself and does not. GitHub's Ubuntu runners restrict the
   user namespaces Chrome's sandbox needs, so the agent's browser died at launch. The crawler (plain Playwright)
   was fine, which is why it looked like "the agent" was broken. Our own sandbox had been hiding this with
   `AIE2E_CHROME_ARGS=--no-sandbox`.
2. **Reports were never uploaded:** `actions/upload-artifact@v4` skips hidden folders by default, and every report
   lives under `.aie2e/`.

### Fix

- `agentChromeArgs()` (`src/browser/chrome.js`): on Linux the agent's Chrome gets `--no-sandbox`, matching
  Playwright; `AIE2E_CHROME_SANDBOX=true` keeps the sandbox. Windows and macOS are unchanged.
- `include-hidden-files: true` on the CI upload.

### Verified

- The full suite and every CI e2e command now pass in a clean copy **without** the sandbox workaround: shop clean
  7/7 (exit 0), shop wrong-total 6/7 (exit 1), TodoMVC 6/6 (exit 0), TodoMVC clear-broken 5/6 (exit 1).
- Unit test for the flag on linux / win32 / darwin and with the opt-out.

---

## 2026-10-30 (Friday midday): a third-party app, decision docs, diagrams

### TodoMVC, an app we did not write

The evaluation so far was on our own shop, which the tool's author also wrote. `examples/todomvc` now serves
the unmodified React TodoMVC production build (tastejs/todomvc, MIT, licence kept next to it) with a 6-test
suite. Results: 6/6 replayed with no LLM; `BUGS=clear-broken` and `BUGS=edit-lost` (a small capture-phase
script added when the page is served, the build itself is never edited) each fail exactly the matching test.

### Found while building it

- **A weak expectation.** "Walk the dog is visible" also passes when "Clear completed" does nothing. Tests
  that change the list now also check the exact number of todos with an XPath count. The judge was right;
  the test was too lenient, which is the mistake an AI planner makes too.
- **A real finding in TodoMVC:** the quality gate reports the todo checkboxes have no accessible label (axe
  `label`, critical). That is a genuine issue in the upstream app, not a seeded one.
- **Prettier reformatted the vendored bundle.** Vendored builds are now excluded from prettier and eslint.

### Docs and diagrams

`docs/DECISIONS.md` (21 numbered decisions, superseded ones kept), `docs/TRADEOFFS.md` (what was not built
and why), `CLAUDE.md` (rules, commands, where things go). `npm run diagrams` is a Node script that works on
Windows; the four stale diagrams were redrawn from the current code (UI, login, theme, visual, suites).

### Verified

- `tests/integration/todomvc.test.js`: clean 6/6, both regressions caught in the right test.
- Full suite: 101 tests pass. `npm run eval`: still 12/12 detected, 0 false positives.
- Sandbox note: Chrome as root needs `AIE2E_CHROME_ARGS="--no-sandbox"`; without it every Stagehand test times out.

---

## 2026-10-30 (Friday): theme conformance across products (`--theme-from`)

- **Why:** "how close are all our products to one theme" was the part of the vision only half covered. Each app
  was checked against its own themes; now one product (a design-system site, or the main app) can be the
  reference for the others.
- **How** (`src/theme/reference.js`): read the reference product once per run, with every theme it ships and
  every token resolved to a real value. The audit then compares the target's values with those tokens, theme
  by theme (light ↔ light, dark ↔ dark, else the reference's base theme).
  - Values are compared, not names: products rarely name tokens alike (`--color-primary` vs
    `--brand-primary`).
  - The target's own `var()` usage no longer counts as "on theme", since its variables might hold another
    brand's colours.
  - A product with no CSS variables at all is still checked, in its default look.
  - Findings are `off-reference`, with the nearest reference token, e.g. `#2563eb` → `--brand-primary`. The
    gate is the score threshold: products may legitimately use a few extra values.
- Entry points: `--theme-from <url>`, the New run form, or a suite's `themeFrom`. The Theme tab and report say
  which product the page was compared with.

### Found while building it: a real audit bug

- **Seen:** on a plain page, an orange promo banner (`#ff6600`) was never checked. The "transparent background"
  test was `/,\s*0\)$/`, which matches any colour whose last channel is 0, so `rgb(255, 102, 0)` counted as
  transparent. Pure red, green and yellow backgrounds were also invisible to the theme audit, the leak check and
  the component inventory.
- **Change:** only an alpha of 0 is transparent (`rgba(…, 0)` or `/ 0`). Verified on sample colours, and the new
  test fails without the fix.

### Verified

- `tests/integration/themeReference.test.js`:
  - the shop against itself is 100% in light and dark, with the message "against <url>";
  - the shop against a violet brand is under 90%, with `#2563eb` off-reference and nearest `--brand-primary`, and
    the judge fails it;
  - a page without CSS variables is audited as "default": the brand violet button matches, the orange promo
    does not.

---

## 2026-10-30 (late morning): test suites in the UI, login flows

### Test suites written in the UI

- **Why:** users need to author their own tests and flows, not only accept what the AI plans. A suite is the same
  JSON file `--suite` and `aie2e export` already use, so what you write in the UI also runs in CI.
- **Server** (`src/server/suites.js`): files `<outDir>/suites/<name>.suite.json`, or a folder in the repo
  (`AIE2E_SUITES_DIR`). List, read, save, delete. Saving validates against the suite schema and returns the
  problems by path (e.g. `tests.0.title`) instead of saving a broken file. `POST /api/suites/from-run/:id` turns
  a finished run into a suite with its recorded steps. Names are slugs, so path tricks are refused.
- **UI** (Test suites page):
  - per test: title, start page and a goal in plain English (empty = page-load check);
  - checks picked from a list of every check the judge supports, each with only its own fields;
  - recorded steps are shown and can be cleared, so the agent records them again;
  - reorder, duplicate, an "Edit as JSON" mode, and Run suite;
  - "Save as suite" on any finished run.
- **Run again** of a UI suite run re-runs the suite by name. A run that used a suite file from the command line
  says so instead of silently planning.

### Login flows

- **Design:** log in once per run, before anything else, with plain Playwright (no AI). Credentials come only
  from `.env` (`AIE2E_USERNAME`/`AIE2E_PASSWORD` or names you choose). They are never stored in suites or reports
  and never sent to the AI. The resulting session (cookies + localStorage, Playwright's `storageState`) is given
  to the crawler and every test.
- **Login detection:**
  - by default it finds the username and password fields, including "email, Next, then password";
  - for unusual logins, `auth.steps` with `{{username}}`/`{{password}}` placeholders;
  - success is checked by text, URL, or by default "the password field is gone and the URL changed".
- **Stagehand owns the browser it launches,** so `newContext({ storageState })` is not an option for test
  sessions. Cookies are added to the context, and localStorage is restored by an init script before any page
  script runs. A shared profile directory was rejected: Chrome locks a profile to one browser, and tests run in
  parallel.
- **The agent is told it is logged in and must not log out:** tests share one session, so one test logging out
  could log out the others.
- A failed login stops the run with the reason and a screenshot (`login-failed.png`), instead of failing every
  test with the same confusing error.
- Entry points: `--login-url` (+ `--login-success-text`/`--login-success-url`), the New run form, or a suite's
  `auth`. The run page and the report say "logged in as …".

### Found while building it

- Hand-written login steps use CSS (`button[type=submit]`), but recorded steps default to XPath, so the step
  timed out. Login steps now treat anything not explicitly XPath as CSS.

### Verified

- `tests/integration/login.test.js`:
  - a form login; the session carries the HttpOnly cookie and localStorage into a new test browser;
  - a two-step login and scripted steps;
  - a wrong password gives `Login as ada@example.com failed: the login form is still there` plus a screenshot;
  - missing credentials point to `.env`;
  - a suite with `auth` passes its logged-in test, and the password appears nowhere in report.json or
    report.html.
- `tests/suites.test.js` (API) and a real-browser UI test: write a suite, save it, check the file, run it, see it
  pass.

---

## 2026-10-30 (morning): visual regression against approved baselines

### What was built

- **Deterministic captures** (`BrowserSession.visualCapture`), taken separately from the step screenshots people
  look at:
  - animations finished and the caret hidden;
  - the harness's own cursor hidden;
  - `data-aie2e-mask` areas painted over;
  - live regions (toasts, status, alerts) hidden.
    The final screen is captured once per theme the build ships. Each replayed step is captured too, named by index
    plus a hash of what it does, so a healed step gets a new baseline instead of a false difference.
- **Comparison:** pixelmatch (ISC, pinned 7.2.0; 8.0 was three weeks old) and pngjs, with anti-aliasing ignored. A
  diff image with the differing pixels in red, the share of pixels changed, and the bounding box of the change. The
  baseline is copied into the run folder, so a report always shows what it was compared with.
- **Baselines** (`src/visual/baselines.js`) are stored in `<dir>/<host>/<test>/<checkpoint>.png` plus
  `baselines.json` (who approved what, when). A test's first passing run creates them, like recordings: only
  judge-approved runs count. A changed test definition starts new ones. `AIE2E_BASELINES_DIR` can point into
  the repo, so baselines are reviewed in pull requests.
- **Gate** `--visual off|warn|fail` (default warn: an intended redesign is a change to approve, not a bug), and
  `--update-baselines`.
- **Review:**
  - a Visual tab per test: baseline, this run and the difference, with Approve as baseline and Reject;
  - `POST /api/runs/:id/visual`, with decisions saved next to the run;
  - a "visual change" marker in the test list and the summary;
  - a section in the HTML report.

### Found while building it

- **pixelmatch's default tolerance (0.1) missed a real layout change.** A grid gap squeezed from 16px to 4px was
  "unchanged", because a light card on a white page differs by a YIQ delta that needs a threshold below ~0.03. One
  machine renders the same page byte-identically, and anti-aliased edges are ignored anyway, so the default is now
  0.02. Raise it for baselines shared across machines.
- **Comparisons cost ~13 s per 7-test run** (PNG decode, plus a diff image written for every screenshot). Now
  byte-identical files are "unchanged" with no decoding at all (the size is read from the PNG header), and a diff
  image is only written when something changed. Overhead is ~3 s per run.
- **Toasts made 1 in 5 runs flaky.** The previous step's "Added T-shirt to cart" toast was still stacked behind
  "Added Notebook" when the steps ran faster. Masking would not fix it (two toasts paint a different box than
  one), so live regions are hidden in comparison captures (`visual.hideLiveRegions`, on by default). Their text is
  still evidence. After the fix: 245 of 245 comparisons stable over 7 repeated runs.
- **Existing bug:** a second attempt of a test (the agent re-checking a failed replay) got a fresh artifacts
  object and overwrote the first attempt's screenshots. `RunArtifacts.forTest` now returns one instance per test.

### Verified

- `tests/integration/visual.test.js`:
  - the first run creates baselines for final, light and dark;
  - a second run is unchanged although a masked counter changes and the cursor moves;
  - a squeezed grid is "changed" in all three, with the diff image and a change box below the masked area;
  - gate fail fails the test.
- `tests/visualReview.test.js`: approve copies into the baselines and records the decision; reject keeps the
  baseline; unknown screenshots and bad run ids are refused.
- CLI end to end: clean (35 baselines created), cramped grid (17 changed), `--update-baselines` (17 re-approved),
  then unchanged.
- Seeded bug `cramped-grid` (visual only) is detected. The evaluation now also reports visual stability across the
  repeated clean runs.

---

## 2026-10-30 (early morning): every screen, cross-page consistency, visible-only text checks

### 1. The theme audit now covers every screen a test reaches, not only the last one

- **Why:** a theme bug inside a dialog, a menu or a step in the middle of a flow was invisible if the test ended
  somewhere else. The new integration test shows exactly that case: a dialog with a hard-coded white surface is
  clean at the end (the dialog is closed again) and only caught by the in-between audit.
- **How:** after every replay step, and after every agent step (Stagehand awaits its `onEvidence` callbacks, so
  the agent is paused), the harness takes a cheap fingerprint of the screen:
  - the route, with ids normalised;
  - open dialogs, menus and listboxes;
  - the visible landmarks;
  - the visible test ids.
    Text is left out because AI apps generate new content every run. Only new screens are audited. A test audits
    at most 4 screens besides the final one (`AIE2E_THEME_STATES`), and screens another test in the same run
    already audited are reused rather than measured twice.
- **Safe for the agent:** in-between audits only crop elements already in view and restore the scroll
  position, so the screenshot the agent just saw still matches the page it acts on.
- The `theme-conformance` check reports problems per screen and merges duplicates, e.g.
  `dark: 1 surface(s) ignore the theme (e.g. #ffffff #d) [after step 1]`. The Theme tab has a screen picker; the
  HTML report shows one block per screen.

### 2. Cross-page consistency (advisory)

- **Why:** a value can be "on theme" on every single screen and the product still drift. The seeded bug: the
  checkout button uses `color-mix(in srgb, var(--color-primary) 88%, black)`. Because it is derived from the token,
  the theme audit correctly accepts it, but it is a different blue from every other primary button.
- **How:** each audit records how buttons, links, inputs, headings and named components look in each theme
  (colours, radius, font, weight, padding). Hovered, focused and pressed elements are skipped, because their look
  is a momentary state. Disabled/selected/pressed variants are compared separately. Across the run:
  - two looks of the same kind of element that differ only slightly are flagged as near-duplicates: ΔE₀₀ between
    2.3 and 10, radius or padding within 2px, size within 1px, weight within 100;
  - an element marked `data-aie2e-component="…"` must look identical everywhere.
    Clearly different looks (secondary buttons, outline buttons, other fonts, large sizes) are deliberate variants
    and are not reported. This is advisory: shown in the run summary and the report, never a failed test.
- **Found:** the seeded hard-coded Subscribe colour is now caught twice, as a theme violation and as a
  near-duplicate of the primary button.

### 3. Text and selector checks ignore hidden copies

- **Seen (code review):** `getByText(text).first()` picks the first match in the DOM, often a hidden copy (closed
  menu, off-screen slide, responsive duplicate), so a visible "Order placed" could still fail the check. The
  baseline had the same flaw in reverse (a check could look earned when it was already visible).
- **Change:** both use `filter({ visible: true })`. The new test fails against the old code and passes now.

### Verified

- 11/11 seeded bugs detected (new: `button-drift`, kind consistency, found as
  `light: two near-identical button styles (background #2563eb vs #2157cf, ΔE 5.3)`), 0 false positives, 0 flaky.
  Run time per suite run unchanged (~26 s).
- New tests: unit tests for `nearDuplicate` (drift vs deliberate variants) and the run-level analysis; real-browser
  tests for the dialog-only theme bug, cross-test reuse, scroll restore and visible-only text checks.

---

## 2026-10-29 (late night): theme conformance of the production build

**Goal (Rohan):** the themes an app's production build ships must actually be applied everywhere, in every
theme, on every state the agent reaches. The source of truth is the build itself, not Figma or a reference site.

### What was built

- **Discovery from the CSSOM** (`src/theme/discover.js`): CSS custom properties defined on `:root`, `.dark`,
  `[data-theme=…]` or under `prefers-color-scheme`. Tailwind v4, shadcn, Radix and MUI CSS variables all land
  here. A class or attribute rule only counts as a theme if it re-defines variables the base defines.
- **Switching** the way the app does it (class, attribute or emulated colour scheme), with transitions frozen,
  and an exact restore afterwards.
- **Audit** (`src/theme/audit.js`), per element and per theme: colours by CIEDE2000 within the just-noticeable
  difference (culori), radii and font sizes against the theme's scale, font family. For every off-theme value,
  Chrome itself is asked which CSS declaration produced it (CDP `CSS.getMatchedStylesForNode`):
  - `var(--…)` = derived from the theme (e.g. `calc(var(--radius) - 2px)`), fine;
  - an author rule without a variable = **hard-coded**, reported with `selector { value }` and file:line;
  - no author rule = **browser default**.
- **Leaks:** large surfaces whose background is identical in every theme while the page background changes
  (the white card in dark mode). **Contrast** is checked per theme (axe `color-contrast`).
- A `theme-conformance` check (auto-added under the quality gate): fails when a theme is under 90% on-theme,
  any value is hard-coded or a browser default, or a surface leaks. A Theme tab in the UI and a section in the
  HTML report show a screenshot per theme, scores per category, and findings with element crops.

### Found while building it

- The unit tests caught a discovery bug: any class defining a variable (`.card { --pad: 8px }`) became a
  "theme". Fixed by requiring themes to override base variables.
- A score threshold alone hid single hard-coded values (one hard-coded button = 98%, above the threshold), so
  the check also fails on any hard-coded value. The score is a summary, not the gate.
- My own theme toggle in the demo shop had `aria-label="Toggle dark mode"` with visible text "Theme": axe
  flagged `label-content-name-mismatch`. Fixed in the shop.
- The off-scale radius bug first went undetected because my edit to the shop's product-card markup never
  applied (prettier had reflowed the line). The audit was right; the seeded bug simply was not there.

### Verified

- `tests/theme.test.js` (discovery rules, matching) and `tests/integration/theme.test.js`: the clean shop
  scores 100% in light and dark with no findings and the page is restored; the buggy shop reports the
  hard-coded colour with `.newsletter button` and its inline-style line, the off-scale radius ×3, and the dark
  leak (only in dark). The judge fails the test with gate = fail.

---

## 2026-10-29 (night): LangGraph, seeded-bug evaluation, committed suites

### 1. Orchestration is now real LangGraph (`@langchain/langgraph` 1.5.3, MIT)

- `START → crawl → plan → (Send: one runTest branch per test) → writeReport → END`, with `Annotation` state.
  The parallel branches append to `results` through a reducer, and the report re-sorts into plan order.
  The node functions are unchanged, and the UI still listens to our own event bus, not graph internals.
- `npm run graph` writes the graph as Mermaid (`docs/diagrams/05-langgraph.mmd`) from the code.

### 2. Found a LangGraph bug: `maxConcurrency: 1` drops Send branches

- **Seen:** the "AI planning end to end" integration test lost its report after the swap. A minimal repro:
  three `Send` branches with `maxConcurrency: 1` → the branches' writes are dropped and the next node never
  runs (`out: []`). With 2 or 3, or with no limit, it works.
- **Change:** parallelism is capped with our own limiter inside the `runTest` branch; LangGraph's
  `maxConcurrency` is not used.
- **Verified:** `tests/pipeline.test.js` checks concurrency 1 (peak 1, all results in order) and concurrency 2
  (peak 2, results in plan order although the first test finishes last).
- Also fixed during the swap: the report node returned `results` again, which the append-reducer would
  have duplicated.

### 3. Seeded-bug app and evaluation

- `examples/buggy-shop`: 7 known, switchable bugs (functional, error, accessibility, performance), clean mode,
  optional hints. No dependencies.
- `npm run eval`: the clean app N times (false positives, flakiness), then each bug alone (exact attribution).
  It writes `docs/EVALUATION.md` and raw JSON. First result (committed suite, no LLM): **7/7 bugs
  detected, 0 false positives over 3 × 7 clean tests, 0 flaky**.
- **The judge caught a bug in the demo app itself:** the first clean run failed 3 tests with
  `pageerror: cart is not defined`. The page scripts ran before the shared helpers were defined. Fixed in the
  app, not in the tester.

### 4. Committed test suites (`--suite`) and `--no-heal`

- A suite is JSON: tests with relative start URLs and optional recorded steps. Tests with steps replay with no
  LLM; tests without steps use the agent and get recorded once they pass. `aie2e export <runId>` turns any
  run into a suite (tests plus recorded steps), ready to commit and run in CI.
- `--no-heal`: a broken replay step is a plain failure, never handed to the agent. It is deterministic and
  free, which suits CI and evaluation. The new verdict path is `outcome.failure` → "fail" (not "error").

---

## 2026-10-29 (evening): judging accuracy, app hints, UI rebuild

**Source:** run `20261029131952-1872` on the AI Presentation Builder: 7/9 passed, 1.04M agent tokens.

### 1. False pass: "change" questions judged from one screenshot

- **Seen:** "Navigate between slides" PASSED, although the agent itself reported failure. The planner asked
  "are navigation controls visible AND does the slide content change?". One final screenshot cannot
  show a change, and the vision model said yes anyway.
- **Change:** visual checks now get a timeline: the start screenshot, up to 3 frames from the run and a
  fresh capture of the page now (consecutive duplicates dropped). The prompt says which image is which,
  and that change questions must compare first and last. The planner is told to phrase changes that way and
  never to stack conditions.
- **Verified:** `tests/integration/judge.test.js` checks that the vision model receives at least 2 images and the
  "first = before the test acted" framing.

### 2. False fail: theme change not recognised

- **Seen:** "Customize theme" FAILED, but the final screenshot shows the new (green) theme. The judge had no
  before image, and one question asked for the theme panel to still be open after it had closed.
- **Change:** the same timeline (above), plus the planner rule about change questions.

### 3. The agent's own "I failed" is now evidence (asymmetric trust)

- **Rule:** a claim of _success_ is still never trusted. A claim of _failure_ is: if the agent says it could
  not finish and the only proof otherwise is an AI reading of screenshots, the verdict is FAIL with an
  explicit reason. Deterministic evidence (URL, text, test id, API call, download, toast) still overrides
  the agent, because agents can be wrong about failing too.
- **Why:** a false pass hides a regression, which is worse than a false fail that someone reviews.
- **Verified:** `judge.test.js`: soft-only evidence + "failed" claim → fail; hard evidence + "failed" claim → pass.

### 4. Blank start screenshots corrupted the baseline

- **Seen:** 6 of 9 start screenshots were blank white (5.5 KB) because they were captured on
  `domcontentloaded`, before the SPA rendered. The vacuity check ("already true at the start?") then
  compared against an empty page.
- **Change:** `session.goto` waits for `load` and then for the page to settle. A page with no text never
  counts as settled. `browser/settle.js` is shared by navigation, replay and judging. It also waits for
  `aria-busy="true"` to clear and for in-flight fetch/XHR, capped.
- **Verified:** `hints.test.js` covers a page that renders 700 ms after load: the baseline contains its text.

### 5. Judge only after the app goes quiet

- **Seen:** AI apps keep streaming ("Building slide 3…") after the agent stops.
- **Change:** before the final evidence the harness settles: text stable for 1 s, no aria-busy, no API
  call in flight, capped at 15 s.

### 6. Heal outcome came from the agent's claim

- **Seen (code audit):** `CachingExecutor` labelled a heal "healed" when the _agent said_ it succeeded.
- **Change:** the TestRunner overwrites every heal outcome with the judge's verdict. `summary.healed` counts only
  healed tests that passed.

### 7. Optional app hints (never required)

- `data-testid` (also `data-test`, `data-cy`, `data-qa`): when the agent clicks something, the harness looks up a
  unique test id on the element (or a close ancestor for clicks) or a non-generated `id`. Recordings store it as
  the selector with the XPath as fallback, and replay tries both. Apps that expose test ids also get two agent
  tools: list them (including hidden ones) and act on one exactly.
- `aria-busy`: a standard attribute the harness waits on.
- `data-aie2e-hint` / `data-aie2e-reveal="hover"`: free text and markers for hover-only or conditional controls.
  They reach the planner (via the crawl) and the agent (instruction plus tools).
- The planner may only assert `selector-visible` on test ids the crawl actually saw.
- **Verified:** `hints.test.js`: hints read including hidden ones; test id preferred and XPath fallback used
  after the id disappears; tools reveal a hover-only control; tool calls become replayable steps.

### 8. Cost visibility and stronger models where they matter

- Planner and judge (visual checks) tokens are now metered and reported as `summary.overhead`.
- `AIE2E_PLANNER_MODEL` / `AIE2E_JUDGE_MODEL` can point the two low-volume, high-leverage calls at a stronger model
  while the browser agent stays on Haiku.
- The planner and agent are told to take the shortest path (sample or template content) unless the test is about
  creating it, because every test regenerating a full deck was the main cost.

### 9. UI rebuilt

- Dark mode (system / light / dark, no flash), Radix primitives for selects, switches, tabs, tooltips and the
  delete confirmation; toasts (sonner).
- Run page: summary with a segmented result bar → filterable test list → tabbed detail (Steps, Checks,
  Network, Quality, Agent). Steps is a timeline with the screenshot taken after every step.
- Screenshots open in an in-app viewer (yet-another-react-lightbox: zoom, thumbnails, captions, keyboard)
  instead of a new tab. The standalone HTML report got the same treatment with a dependency-free viewer.
- "Run again", an "App hints" guide page, and the options a run started with are kept next to its report.

---

## 2026-10-29 (afternoon): quality evidence, cursor, live view

- **Seen:** all 3 failures in run 12:47 were test-spec errors. The planner guessed URL fragments (`/presentation`,
  `slideshow`, `download`), and a download toast had vanished before the end-of-test screenshot.
- **Change:** collectors for fetch/XHR, downloads, transient toasts, Core Web Vitals (`web-vitals`) and axe-core
  accessibility; new expectations `api-call`, `download`, `text-appeared`, `web-vitals`, `no-a11y-violations`;
  quality gate off/warn/fail; vacuity for API calls; planner drops ungrounded URLs and endpoints.
- **Cursor:** eased glide instead of teleporting; position kept across navigations.
- **Live view:** CDP screencast (more than 20 frames in 2 s in tests) instead of 4 fps screenshot polling.
- **Hover-only controls:** `hoverAt` agent tool, recorded as a `mouse` step in viewport percentages.

## 2026-10-29 (morning): first real runs

- **Thinking-signature error** with `claude-haiku-5-5`: Stagehand 3.7.3 does not know the model and its loop
  rewrites messages, which invalidates Anthropic thinking signatures. The default became `claude-haiku-4-5`
  with thinking off.
- **"Executable doesn't exist (chrome-headless-shell)"** on Windows: the Chrome resolver falls back to an
  installed Chrome or Edge.
- **Cursor init script threw** (`appendChild` on null before the document existed). Pages then logged an error
  and 7 integration tests failed. The script now has host guards and a try/catch, because a debugging aid must
  never change the page under test.
- **Vacuous expectations:** "text `edit` visible" passed although it was on the page before the agent did
  anything. The judge now takes a baseline before acting; checks that were already true are not counted, and
  a goal test needs at least one real one.
