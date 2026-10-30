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

## Schedule (deadline Mon 2 Nov) · re-evaluated Fri 30 Oct, 04:00

### Status check (verified against the code)

Built and tested (97 tests, eval 12/12, 0 false positives, 0/70 visual drift):

- Thu: agent loop, strict judge, planner, crawler, parallel runs, reports, record/replay/heal, cursor, local UI,
  quality evidence, app hints, LangGraph, suites + export, CI workflow, seeded-bug shop + eval, theme conformance v1.
- Fri (night): theme audit on every screen, cross-page consistency, visible-only text checks.
- Sat items, done early: visual baselines + approve/reject, test suites in the UI, login flows.

Done on Rohan's machine: repo pushed to GitHub (2 commits). Not verifiable right now: obsolete files deleted,
`ci.yml` in `.github/workflows/`, `npm install` after the new dependencies (pixelmatch, pngjs), CI green.

**Never run on a real app yet (the biggest risk):** everything built since Thursday afternoon with the real LLM
agent: theme audits between agent steps, visual comparison of agent runs, login on a real site, consistency on
real CSS. Also never measured: the full-AI evaluation (planner + agent on the shop).

### Re-plan

**Fri (Rohan, about 1.5 h, whenever ready)**

- [ ] Sync the machine (checked 10:45: all files match the verified copy, but `.github/workflows/ci.yml` is missing,
      `@types/react` is not installed and two batches are uncommitted): `npm install`, save `ci.yml`, 3 commits, push, CI green.
      Do not run `finish-thursday.cmd` again: it writes an older `ci.yml`
- [ ] Presentation Builder run in light and dark (`npm run ui`). Use `--visual off` or mask the generated slides:
      AI-generated content differs every run by design. Paste the report → fixes
- [ ] Full-AI evaluation once: `npm run eval -- --mode explore --heal --runs 1 --report docs/EVALUATION_AI.md` (costs tokens)
- [ ] Rehearse the demo: replay at 0 tokens, a forced heal, a wrong expectation failing, a visual change approved, a theme leak

**Sat (mostly Claude)**

- [x] Cross-product theme conformance: `--theme-from <url>` (reference product's tokens, values not names); found and fixed the transparency bug

- [x] Third demo app: TodoMVC (React build, MIT) with a 6-test suite: 6/6 on replay, 2 injected regressions each caught by the right test; found a real a11y issue in TodoMVC
- [x] Attribute types `.d.ts` for JSX: data-testid family, aria-busy, data-aie2e-hint / -reveal / -mask / -component /
      -ignore-theme (`data-aie2e-theme` dropped: themes are discovered from the CSS, nothing to declare)
- [x] Reusable GitHub Action (`action.yml`, composite) for other repos; job summary, outputs, report artifact; CI job uses it on the shop
- [x] `npm run diagrams` as a Node script (works on Windows) and refresh all five diagrams
- [x] `CLAUDE.md`, `docs/DECISIONS.md` (D1–D21), `docs/TRADEOFFS.md`
- [ ] Fixes from Friday's real runs (first priority if any)
- [ ] Optional: Sauce Demo (saucelabs/sample-app-web, MIT) built locally: 0-token real-app demo with login and
      seeded bug users (problem_user, error_user, visual_user, performance_glitch_user, locked_out_user)

**Sun**

- [ ] README final pass (features, eval incl. full-AI numbers, honest limits)
- [ ] Demo script + GIF (needs Rohan's screen)
- [ ] Optional: static showcase on Vercel (study guide, sample report, GIF)
- [ ] Buffer for anything the real runs exposed

**Mon:** final evaluation runs, one final run, chat transcripts. No new features.

**Cut (decided):** DTCG token-file override, AI triage of visual diffs, compare two runs, Dockerfile.

**Cut order if behind:** reference-site/Figma comparison → Playwright spec export → MCP server → AI diff triage.
**Never cut:** strict judge, record/replay/heal, live view, theme conformance v1, evaluation table, honest limits.
