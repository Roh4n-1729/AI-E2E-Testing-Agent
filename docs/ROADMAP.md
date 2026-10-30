# Roadmap: real-time AI testing + theme conformance (updated Fri 30 Oct, 04:00, re-evaluated)

## Vision (Rohan, 29 Oct)

1. Test the REAL app in real time (real backend, real data, every interaction): the gap the interviewer's
   team has with mock-data Playwright suites.
2. Users author their own test cases and user flows; AI fills in, records and heals them.
3. **Theme conformance of the production build:** the themes the app ships (light, dark, brand themes, as
   CSS variables / design tokens in the built CSS) must actually be applied everywhere, in every theme, on
   every state the agent reaches. The source of truth is the app's own production build, not reference
   websites or Figma (those become optional extras later).
4. Proper end-to-end visual testing: baselines, diffs, AI triage.
5. An optional attribute contract in client code (like data-testid for Playwright) that the system picks up.

## Where we stand

| Pillar                            | Status  | Done                                                                                                                                                                | Missing                                    |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Real-time AI testing on real apps | ~85%    | real browser and backend, agent + replay + heal, strict evidence judge, API/download/toast/vitals/a11y evidence, settle, login flows                                | test data setup/cleanup                    |
| User-authored tests and flows     | ~90%    | UI test suite editor (goal + checks + recorded steps), JSON mode, run, save run as suite; CLI suites, export                                                        | tags/filters                               |
| Theme conformance                 | v1.2 ✅ | CSSOM discovery, switching, CDP declaration lookup, CIEDE2000, leaks, contrast, every screen, cross-page consistency, across products (--theme-from), 4 seeded bugs | first real run on the Presentation Builder |
| Visual testing                    | ~85%    | baselines per step and per theme, pixel diff, masks, live regions hidden, approve/reject in UI and API, gate warn/fail                                              | AI diff triage (cut first)                 |
| Client attribute contract         | ✅      | data-testid family, aria-busy, data-aie2e-hint, -reveal, -mask, -component, -ignore-theme; JSX types with a compile check                                           |                                            |

## Design: theme conformance (source of truth = the production build)

**1. Discover the themes the build ships** (no config needed):

- Read the loaded stylesheets (CSSOM) for CSS custom properties and where they are defined: `:root`,
  `.dark`, `[data-theme="…"]`, `[data-mode]`, `@media (prefers-color-scheme: dark)`. That gives the theme list
  and each theme's token values (Tailwind v4 `@theme`, shadcn, Radix Themes, MUI CSS vars and hand-written
  vars all end up here).
- Optional overrides: a DTCG token file (W3C format 2025.10), or `data-aie2e-theme` hints, for builds that bake
  values in (e.g. Tailwind v3 without CSS variables).

**2. Run every state in every theme:** switch theme the way the app does (`page.emulateMedia({ colorScheme })`,
toggling the class or `data-theme` on `<html>`, or the app's own toggle) and re-run the audit after each switch.

**3. Audit, per element, per theme:**

- **Hard-coded values:** ask Chrome (CDP `CSS.getMatchedStylesForNode`) which declaration produced the colour,
  background, border, radius and font. `var(--primary)` = on-theme; `#2f6fe4` = hard-coded. Exact, not a guess.
- **Value match:** resolved values that equal no token of the active theme (colours by CIEDE2000 ΔE via culori,
  sizes by scale step) are off-theme.
- **Theme leaks:** in dark mode, surfaces that keep light-theme values (and the reverse); contrast per theme.
- **Consistency:** the same component rendered with different token values across pages.
- Score per theme and category; findings with selector, element crop, value, declaration source and nearest token.
- New expectation `theme-conformance` (min score, no leaks), gated off / warn / fail like quality.

**4. Later, optional:** reference websites and Figma (Variables API is Enterprise-only; others via DTCG export).

## Design: visual regression

- Baseline = approved screenshots per test step and per theme; later runs diff each step (pixelmatch or odiff).
- Masks: `data-aie2e-mask` regions (timestamps, AI-generated text) are blanked before diffing.
- AI triage of each diff (layout vs content vs noise); approve or reject the new baseline in the UI.

## Client attribute contract (all optional)

`data-testid` (and data-test, data-cy, data-qa), `aria-busy`, `data-aie2e-hint`, `data-aie2e-reveal`,
plus new: `data-aie2e-mask`, `data-aie2e-component`, `data-aie2e-theme`. Shipped with a `.d.ts` so React/JSX
props autocomplete and type-check.

## Schedule (deadline Mon 2 Nov) · re-evaluated Fri 30 Oct, 11:30

### Status check (verified against the code and Rohan's folder)

Built and tested (105 tests; buggy-shop 12/12 with 0 false positives; TodoMVC 6/6 and 2 regressions caught;
Sauce Demo: every broken user caught for the right reason; 0 tokens for all of it):

- Thu: agent loop, strict judge, planner, crawler, parallel runs, reports, record/replay/heal, cursor, local UI,
  quality evidence, app hints, LangGraph, suites + export, CI workflow, seeded-bug shop + eval, theme v1.
- Fri: theme on every screen, consistency, visible-only checks, visual baselines + review, suites in the UI,
  login, `--theme-from`, JSX attribute types, GitHub Action, TodoMVC, Sauce Demo, suite `ignore`, diagrams,
  DECISIONS / TRADEOFFS / CLAUDE.md, first-CI-run fixes.

Rohan's folder (11:30): every file matches the tested copy, **except** `.github/workflows/ci.yml` (old version).
Pushed: 7 commits up to "docs: decisions, trade-offs…". **Not committed yet:** the Linux Chrome fix, Sauce Demo,
suite `ignore`. CI run #1 failed (fixed, not pushed). `@types/react` not installed locally. No AI run since Thu.

### What is left

**Rohan (blocking, in this order)**

- [ ] Replace `.github/workflows/ci.yml` with the latest one, `npm install`, commit, push → CI run #2 green
- [ ] Full-AI evaluation once (step 4), command below the list
- [ ] Rehearse the demo with `docs/DEMO.md`; record the GIF (Sun)
- [ ] Mon: final run, save chat transcripts, submit

```bash
npm run eval -- --mode explore --heal --runs 1 --bugs dead-button,wrong-total,fake-subscribe,no-validation,console-error,dark-leak --report docs/EVALUATION_AI.md
```

**Claude**

- [x] Fixes from the first AI run: baselines only from clean runs, planner test data + effect checks, agent
      fake-data rule (honest result of that run: 3/6, 1 false positive; see IMPROVEMENTS)
- [ ] Re-run the AI evaluation with the fixes (Rohan), then the numbers go into README and EVALUATION_AI.md
- [x] Demo script `docs/DEMO.md` (Sauce Demo for the AI part: 0 tokens for the app itself)
- [x] README pass: quick start for 3 demo apps, evaluation, honest limits, library licences, Flowtrace link
- [ ] README: add the AI-path numbers and "green in CI" once they are in
- [x] Remove `scripts/finish-thursday.*` (obsolete; writes an old ci.yml), refresh KICKOFF demo story
- [ ] Optional: static showcase on Vercel (study guide, sample report, GIF)

**Dropped:** the Presentation Builder run (its own AI costs tokens on every test; Sauce Demo covers the real-app
case). Optional later if a demo mode lands in that app.

**Cut (decided):** DTCG token-file override, AI triage of visual diffs, compare two runs, Dockerfile, Playwright
spec export, MCP server.
**Never cut:** strict judge, record/replay/heal, live view, theme conformance, evaluation table, honest limits.
