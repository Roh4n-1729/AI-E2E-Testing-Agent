# ai-e2e-agent

AI-agent-driven end-to-end testing for any web app. Give it a URL: it explores the app, plans
user-flow tests, runs them with an AI agent driving a real browser, and **decides pass/fail from
evidence the agent cannot fake**: the page, the URL, network calls, downloads, toasts, console errors
and screenshots. Tests that pass are recorded and **replayed with plain Playwright and no LLM**. When a
replay breaks, the agent heals it, and every heal is logged.

> Final-round interview project (deadline 2 Nov 2026). Status: working end to end, tested on three apps (one with
> seeded bugs, two we did not write), checked in CI on every push. [docs/EVALUATION.md](docs/EVALUATION.md) has the measured
> results, [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) what real runs taught us, and [docs/DEMO.md](docs/DEMO.md)
> the 8-minute demo.

## How it works

```
START → crawl → plan ──(one LangGraph branch per test)──▶ run test → write report → END

run test:   recording? ──yes──▶ replay with Playwright (no LLM) ──step breaks──▶ agent heals from here
               └──no──▶ AI agent (Stagehand) drives the browser ──passes──▶ saved as a recording
            then: strict judge, from harness evidence only → pass / fail / error
```

- **Strict judge.** It never trusts the agent's claim of success. It ignores checks that were already true
  before the agent acted. Visual checks compare the start, the run and the end. If the agent says it
  failed and only an AI reading of screenshots says otherwise, the test fails.
- **Quality on every test.** Core Web Vitals (`web-vitals`), accessibility (`axe-core`), API calls and slow
  endpoints, downloads, and transient messages, with a quality gate that can be off, warn or fail.
- **Theme conformance of your production build.** The themes your CSS ships (light, dark, brand themes as CSS
  variables) are discovered automatically. Every element on every screen a test reaches is checked in every theme,
  and Chrome reports the exact CSS rule behind each hard-coded value. Leaks such as a white card in dark mode are
  caught too, and buttons, links, inputs and headings are compared across screens to catch drift (a slightly
  different blue on one page). `--theme-from <url>` checks a product against another product's themes: are all
  your products on one theme?
- **Visual regression.** Deterministic screenshots of the final screen, each theme and each replayed step are compared
  pixel by pixel with approved baselines. The first passing run creates them; changes are approved or rejected in the
  UI. Mark changing content with `data-aie2e-mask`.
- **Your own tests, and apps behind a login.** Write suites in the UI (a goal in plain English plus checks), save
  any run as a suite, and run the same JSON in CI. Runs can log in first: credentials stay in `.env`, the session
  is shared by every test, and the AI never sees the password.
- **Watch it live.** A local web UI streams the browser (CDP screencast) with a visible cursor, then shows
  each test as a step timeline with screenshots, checks, network, quality and the agent's own claim.

## Quick start

```bash
npm install
npm run browsers            # Playwright's Chromium (or it uses your installed Chrome/Edge)
cp .env.example .env        # add ANTHROPIC_API_KEY (default model: anthropic/claude-haiku-4-5)
npm run doctor              # checks Node, Chromium, API key

npm run ui                  # web UI at http://localhost:4173: start runs, watch live, browse results
```

Try it on the demo apps (they run locally; replays need no API key):

```bash
npm run shop                # :4300, a shop with 12 switchable bugs (BUGS=none for the clean app)
npm run todomvc             # :4400, the React TodoMVC build
npm run saucedemo           # :4500, Sauce Labs' demo shop; bugs depend on who logs in

npm start -- run http://localhost:4300 --suite examples/buggy-shop/suite.json --no-heal
npm start -- run http://localhost:4400 --suite examples/todomvc/suite.json --no-heal
# Sauce Demo needs AIE2E_USERNAME (standard_user, problem_user, ...) and AIE2E_PASSWORD=secret_sauce
npm start -- run http://localhost:4500 --suite examples/saucedemo/suite.json --no-heal
```

CLI:

```bash
# AI explores and plans (the first run records, later runs replay)
npm start -- run https://your-app.test -d "What the app is, in one sentence" -c 2

# one flow, in plain English
npm start -- run https://your-app.test --goal "Add a product to the cart and check out" --expect-text "Thank you"

# no AI at all: smoke check (errors, Web Vitals, accessibility)
npm start -- run https://your-app.test --no-plan

# a committed suite (tests with recorded steps replay with no LLM); --no-heal makes it CI-strict
npm start -- run http://localhost:4300 --suite examples/buggy-shop/suite.json --no-heal

# visual regression: warn (default) | fail; accept the current screenshots as the new baselines
npm start -- run http://localhost:4300 --suite examples/buggy-shop/suite.json --visual fail
npm start -- run http://localhost:4300 --suite examples/buggy-shop/suite.json --update-baselines

# is this product on the same theme as our design-system site? (values compared, not variable names)
npm start -- run https://app-two.your-company.com --theme-from https://design.your-company.com

# an app behind a login (username/password from AIE2E_USERNAME / AIE2E_PASSWORD in .env)
npm start -- run https://staging.your-app.com --login-url /login --login-success-text "Welcome back"

# turn any run into a suite you can commit
npm start -- export <runId> -o my-app.suite.json
```

Exit codes: `0` all passed, `1` a test failed, `2` an error occurred. Reports: `.aie2e/runs/<runId>/report.html`
(self-contained, light/dark) and `report.json`.

## Evaluation

`examples/buggy-shop` is a small shop with 12 switchable, known bugs (functional, error, accessibility, performance,
theme, consistency and visual). `npm run eval` runs the clean app
several times and then each bug on its own:

> **12/12 seeded bugs detected (incl. 3 theme, 1 consistency and 1 visual-only bug) · 0 false positives over 3 × 7 clean tests · 0 flaky tests** (committed suite,
> no LLM). Details and the per-bug table: [docs/EVALUATION.md](docs/EVALUATION.md).
> `npm run eval -- --mode explore --heal` measures the full AI path (planner + agent).

The same suite format works on an app we did not write: `examples/todomvc` (the React TodoMVC build) passes
6/6 with no LLM, each injected regression fails exactly the test it should, and the quality gate found a real
accessibility issue in TodoMVC itself (unlabelled checkboxes). See the TodoMVC section of the evaluation.

`examples/saucedemo` is Sauce Labs' demo shop, built locally from its MIT source: a real app with a login whose
bugs depend on who logs in. The same 6-test suite passes as `standard_user` and fails for the right reasons as
`problem_user`, `error_user` and `visual_user`; `performance_glitch_user` passes with slow-page warnings and
`locked_out_user` stops at login. 0 tokens after the first recording: see
[examples/saucedemo/README.md](examples/saucedemo/README.md).

CI runs every demo suite on each push: the clean apps must pass, and a seeded regression in each (the shop's
wrong total, TodoMVC's broken "Clear completed", Sauce Demo's `problem_user`) must fail. See
`.github/workflows/ci.yml`. Other repos can use the tool as a GitHub Action
(`uses: Roh4n-1729/AI-E2E-Testing-Agent@main`): see [docs/GITHUB_ACTION.md](docs/GITHUB_ACTION.md).

## Optional app hints

Nothing is required. If your app adds `data-testid`, `aria-busy` or `data-aie2e-hint`, recordings use stable
selectors, the harness waits for busy states, and the agent finds hover-only or conditional controls. See
[docs/APP_HINTS.md](docs/APP_HINTS.md).

## Stack

Node 22, JavaScript (ESM) + JSDoc types checked by `tsc`. Why each library:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#libraries-all-open-source). Licences as shipped in the installed
packages:

| Library                                       | Used for                                    | Licence    |
| --------------------------------------------- | ------------------------------------------- | ---------- |
| Stagehand 3.7                                 | the AI browser agent                        | MIT        |
| Playwright 1.64                               | browser control, replay, evidence           | Apache-2.0 |
| LangGraph JS 1.5                              | orchestration (crawl → plan → run → report) | MIT        |
| Vercel AI SDK 5 (+ Anthropic, OpenAI, Google) | structured LLM calls (planner, judge)       | Apache-2.0 |
| zod 4                                         | schemas for suites, recordings, reports     | MIT        |
| axe-core 4                                    | accessibility checks                        | MPL-2.0    |
| web-vitals 5                                  | Core Web Vitals                             | Apache-2.0 |
| culori 4                                      | colour maths for theme checks (ΔE)          | MIT        |
| pixelmatch 7 + pngjs 7                        | visual diffs                                | ISC, MIT   |
| Fastify 5                                     | local server + SSE                          | MIT        |
| React 19, Tailwind v4, Radix UI, Vite 7       | web UI                                      | MIT        |
| Commander, dotenv                             | CLI, `.env`                                 | MIT, BSD-2 |
| Vitest 3                                      | tests                                       | MIT        |

## Honest limits

- Login is username + password (one form, two steps, or scripted steps). No OTP/2FA or SSO consent screens
  unless you script them; one shared session per run.
- UI testing only: no API or backend test generation.
- Runs locally or in CI, not as a hosted service. No run video; each step's screenshot is kept instead.
- The visual judge is an LLM. It sees screenshots from the whole run, but deterministic checks (text, URL, test id, API
  call, download) are always stronger and the planner prefers them.
- The committed-suite numbers are replays (0 tokens, deterministic). The AI path (planner + agent) varies from
  run to run and costs tokens: `npm run eval -- --mode explore --heal` measures it.
- Real apps make third-party noise (fonts, analytics, error reporters). It fails the console and network guards
  until a suite declares it in `ignore`; the requests still show in the evidence.
- On Linux the agent's Chrome runs without Chrome's own sandbox, as Playwright's browsers do by default (CI runners
  cannot start it otherwise). Test apps you trust, or set `AIE2E_CHROME_SANDBOX=true` where the sandbox works.
- Stagehand 3.7.3 does not support `claude-haiku-5-5` in its agent loop (thinking-signature error). Use
  `claude-haiku-4-5` for the agent, and optionally a stronger model for the planner and judge
  (`AIE2E_PLANNER_MODEL`, `AIE2E_JUDGE_MODEL`).

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Improvements log](docs/IMPROVEMENTS.md) ·
[Evaluation](docs/EVALUATION.md) · [App hints](docs/APP_HINTS.md) · [Kickoff](docs/KICKOFF.md) ·
[Decisions](docs/DECISIONS.md) · [Trade-offs](docs/TRADEOFFS.md) · [GitHub Action](docs/GITHUB_ACTION.md) ·
[Demo script](docs/DEMO.md) ·
[Study guide](docs/STUDY_GUIDE.md) (animated version: `docs/study-guide.html`)

## Credits

Ideas, not code, from: Playwright Test Agents (planner / generator / healer), Octomind (record and self-heal),
Magnitude (vision-first agents), [Flowtrace](https://github.com/57hemanth/flowtrace) (plain-English tests run
by an agent on Playwright), and TestSprite (result presentation).

Demo apps we did not write, served from production builds of their unmodified source with their licences next
to them: [TodoMVC (React)](https://github.com/tastejs/todomvc) (MIT) and
[Swag Labs / Sauce Demo](https://github.com/saucelabs/sample-app-web) (MIT).
