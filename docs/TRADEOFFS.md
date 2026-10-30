# Trade-offs: what was not built, and why

The decisions that were taken are in [DECISIONS.md](DECISIONS.md). This page is the other half: the
reasonable alternatives that were rejected or postponed, so the choice can be revisited with the reason
in front of you.

## Engine

| Alternative                                           | Why not (now)                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stagehand v4**                                      | Too new at the start of the project; breaking API changes were still landing. 3.x is stable and documented.                                                         |
| **Magnitude** as the engine                           | Strong vision-first agent, but it owns the whole loop. We need our own judge and our own record/replay; it is credited as a reference for the planner/runner split. |
| **Playwright Test Agents** (planner/generator/healer) | They generate `.spec.ts` files for a human to maintain. We wanted JSON steps the tool itself replays and heals, plus an evidence judge. Credited as a reference.    |
| **Pure vision agent** (screenshots + coordinates)     | Expensive per step and hard to replay deterministically. DOM-based actions record to selectors; vision is used only for the `visual` expectation.                   |
| **Browser pool** (reuse Chromium across tests)        | Faster, but leaks state between tests. Isolation first: one fresh browser per test; pooling is an optimisation for later.                                           |

## Judging

| Alternative                                      | Why not                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trust the agent's "success"**                  | The main failure of naive AI testers: agents report success they did not achieve. Measured early on and designed out (D5).                                            |
| **LLM judges the final screenshot**              | Missed "did it _change_" questions from one image and was fooled by stale state. Kept only for author-written visual questions, with start, step and end screenshots. |
| **Screenshot diff as the pass/fail judge**       | Too noisy for functional checks (any copy change fails). Used for visual regression only, against approved baselines, with masks and live regions hidden.             |
| **Auto-heal that rewrites expectations**         | Would turn every regression into a green build. Heals may change _how_ a step is done, never _what_ is checked (D6).                                                  |
| **Hard-fail on quality/theme/visual by default** | Too many false alarms on day one; `warn` by default, `fail` when a team is ready (D15).                                                                               |

## Product

| Alternative                                     | Why not (roadmap)                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **TypeScript**                                  | JSDoc + `tsc --checkJs` gives the same checking without a build step; faster on a 5-day deadline (D3).             |
| **Hosted backend + database, dashboard**        | Out of scope. Runs, suites and baselines are files: easy to commit, diff and review in a PR.                       |
| **Tracing platform** (Langfuse / LangSmith)     | Useful once the core works; the report already shows every step, heal, token cost and screenshot. Roadmap.         |
| **Multi-model support and comparison UI**       | One model string (`AIE2E_MODEL`) works with any provider the AI SDK supports; a comparison UI is roadmap.          |
| **DTCG design-token files** as the theme source | Most apps do not ship one; reading the production CSS works everywhere. A token-file import is roadmap.            |
| **AI triage of visual diffs**                   | Nice for review, but would put an LLM back into a deterministic check. Humans approve or reject in the UI for now. |
| **Dockerfile**                                  | The GitHub Action and `npm ci && npx playwright install` cover CI; a container is roadmap.                         |
| **Run comparison** (this run vs last run)       | Baselines and the cache already carry history; a side-by-side view is roadmap.                                     |
