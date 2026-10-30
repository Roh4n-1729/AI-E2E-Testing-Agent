# CLAUDE.md

Guidance for AI coding assistants (and new humans) working in this repo. Read `docs/ARCHITECTURE.md`
for the design and `docs/DECISIONS.md` for why it is this way.

## What this is

`ai-e2e-agent`: given a URL (and optionally a description, a committed suite, a login), it crawls the
app, plans user-flow tests, runs them with an AI agent in a real browser, records passing runs as JSON
steps that plain Playwright replays with no LLM, and judges pass/fail only from evidence the harness
collected. CLI (`src/cli/main.js`), local web UI (`npm run ui`), and a GitHub Action (`action.yml`).

## Commands

```bash
npm install && npx playwright install chromium
npm run check        # tsc --checkJs on src + the JSX attribute types
npm run lint         # eslint
npm run format       # prettier --write (CI runs prettier --check)
npm test             # vitest; browser tests skip if Chromium is missing
npm run eval         # seeded-bug evaluation, writes docs/EVALUATION.md (no LLM)
npm run shop         # demo app with switchable bugs, :4300
npm run todomvc      # third-party demo app, :4400
npm run saucedemo    # Sauce Demo with login, :4500 (AIE2E_USERNAME=<user>, AIE2E_PASSWORD=secret_sauce)
npm run ui           # web UI, :4173
npm run diagrams     # docs/diagrams/*.mmd -> PNG
```

On Linux the agent's Chrome runs without Chrome's sandbox (like Playwright's own launches), so CI and root
containers work with no flags; `AIE2E_CHROME_SANDBOX=true` keeps it.

## Rules (each one is tested; do not break them)

1. **JavaScript (ESM) + JSDoc types.** No TypeScript source files. Every new function gets JSDoc types; `npm run check` must pass.
2. **The judge never trusts the agent.** Verdicts come from harness evidence. An agent claim of success is recorded, never used to pass.
3. **Heals never hide regressions.** A healed run is judged by the same checks; on fail the cache is not updated.
4. **Vacuity:** a test with only guard checks cannot pass.
5. **Only `src/browser/session.js` touches Stagehand/Playwright pages** (replay steps in `executor/replayExecutor.js` are the exception, through the session's page).
6. **Zod schemas in `src/core/types.js` are the contract** for suites, recordings, reports and config. Change the schema first.
7. **Nothing in `src/` knows about a specific app.** Demo apps live in `examples/`.
8. **Secrets only from env.** Login passwords never reach the LLM, suites, reports or logs.
9. **New checks are advisory by default** (`warn`), opt-in to `fail`.

## Where things go

| Change                     | Place                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| New expectation kind       | `core/types.js` schema → `judge/evidenceJudge.js` case → `ui/src/screens/Suites.jsx` `KINDS` → test |
| New evidence from the page | `browser/collectors.js` or `browser/session.js#collectEvidence`                                     |
| New recorded step method   | `executor/replayExecutor.js#runStep` + `executor/steps.js`                                          |
| New config option          | `config/config.js` (schema + env var) + `.env.example`                                              |
| New CLI flag               | `cli/main.js` → `app/startRun.js` options; mirror in `server/app.js` `StartBody` and `action.yml`   |

## Docs to keep current

`docs/IMPROVEMENTS.md` (dated log of what changed and what was found), `docs/ROADMAP.md`,
`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and the study guide (`docs/STUDY_GUIDE.md` and
`docs/study-guide.html`): every feature gets a short explanation there.

## Current status (update when it changes)

- Done: record/replay/heal, strict judge, crawler, planner, LangGraph, web UI, suites, login, quality,
  theme (every screen, consistency, `--theme-from`), visual baselines, GitHub Action, 3 demo apps
  (buggy-shop eval 12/12, TodoMVC 6/6, Sauce Demo: every broken user caught), decision docs, CI green
  pending the push of the Linux Chrome fix.
- Pending: CI run #2 (fix pushed by Rohan); full-AI eval (`--mode explore --heal`); demo rehearsal with
  `docs/DEMO.md`; demo GIF. The Presentation Builder run was dropped (its own AI spends tokens per test).

## Gotchas

- zod v4: nested object defaults need `.prefault({})`, not `.default({})`.
- LangGraph `maxConcurrency: 1` drops `Send` branches; the pipeline works around it.
- `pixelmatch` is pinned to 7.2.0 (8.0 was too fresh when chosen).
- Vendored third-party builds (`examples/todomvc/app`, `examples/saucedemo/app`) are excluded from prettier and
  eslint; never reformat them.
- Third-party noise on a demo or real app goes in the suite's `ignore` block, never into code.
