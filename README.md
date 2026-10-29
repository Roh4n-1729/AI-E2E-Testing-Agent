# ai-e2e-agent

AI-agent-driven end-to-end testing for any web app. Give it a URL: it explores the app, plans
user-flow tests, runs them with an AI agent driving a real browser, and **decides pass/fail from
evidence the agent cannot fake**: the page, the URL, network calls, downloads, toasts, console errors
and screenshots. Tests that pass are recorded and **replayed with plain Playwright and no LLM**. When a
replay breaks, the agent heals it, and every heal is logged.

> Final-round interview project (deadline 2 Nov 2026). Status: working end to end. See
> [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) for what real runs taught us, and
> [docs/EVALUATION.md](docs/EVALUATION.md) for measured results.

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
  different blue on one page).
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

CLI:

```bash
# AI explores and plans (the first run records, later runs replay)
npm start -- run https://your-app.test -d "What the app is, in one sentence" -c 2

# one flow, in plain English
npm start -- run https://your-app.test --goal "Open the sample deck and export it as PowerPoint"

# no AI at all: smoke check (errors, Web Vitals, accessibility)
npm start -- run https://your-app.test --no-plan

# a committed suite (tests with recorded steps replay with no LLM); --no-heal makes it CI-strict
npm start -- run http://localhost:4300 --suite examples/buggy-shop/suite.json --no-heal

# turn any run into a suite you can commit
npm start -- export <runId> -o my-app.suite.json
```

Exit codes: `0` all passed, `1` a test failed, `2` an error occurred. Reports: `.aie2e/runs/<runId>/report.html`
(self-contained, light/dark) and `report.json`.

## Evaluation

`examples/buggy-shop` is a small shop with 11 switchable, known bugs (functional, error, accessibility, performance,
theme and consistency). `npm run eval` runs the clean app
several times and then each bug on its own:

> **11/11 seeded bugs detected (incl. 3 theme bugs and 1 consistency bug) · 0 false positives over 3 × 7 clean tests · 0 flaky tests** (committed suite,
> no LLM). Details and the per-bug table: [docs/EVALUATION.md](docs/EVALUATION.md).
> `npm run eval -- --mode explore --heal` measures the full AI path (planner + agent).

CI runs the same suite against the clean shop (must pass) and against a seeded regression (must fail):
see `.github/workflows/ci.yml`.

## Optional app hints

Nothing is required. If your app adds `data-testid`, `aria-busy` or `data-aie2e-hint`, recordings use stable
selectors, the harness waits for busy states, and the agent finds hover-only or conditional controls. See
[docs/APP_HINTS.md](docs/APP_HINTS.md).

## Stack

Node 22, JavaScript (ESM) + JSDoc types checked by `tsc`. Stagehand 3.7 (AI browser agent), Playwright 1.64,
LangGraph JS (orchestration), Vercel AI SDK + zod (structured LLM calls), axe-core, web-vitals, Fastify (local
server + SSE), React 19 + Tailwind v4 + Radix UI (web UI), Vitest. Why each one:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#libraries-all-open-source).

## Honest limits

- No login flows yet (public pages, demo modes and sample data only).
- UI testing only: no API or backend test generation.
- Runs locally or in CI, not as a hosted service. No run video; each step's screenshot is kept instead.
- The visual judge is an LLM. It sees screenshots from the whole run, but deterministic checks (text, URL, test id, API
  call, download) are always stronger and the planner prefers them.
- Stagehand 3.7.3 does not support `claude-haiku-5-5` in its agent loop (thinking-signature error). Use
  `claude-haiku-4-5` for the agent, and optionally a stronger model for the planner and judge
  (`AIE2E_PLANNER_MODEL`, `AIE2E_JUDGE_MODEL`).

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Improvements log](docs/IMPROVEMENTS.md) ·
[Evaluation](docs/EVALUATION.md) · [App hints](docs/APP_HINTS.md) · [Kickoff](docs/KICKOFF.md) ·
[Study guide](docs/STUDY_GUIDE.md) (animated version: `docs/study-guide.html`)

## Credits

Ideas, not code, from: Playwright Test Agents (planner / generator / healer), Octomind (record and self-heal),
Magnitude (vision-first agents), Flowtrace, and TestSprite (result presentation).
