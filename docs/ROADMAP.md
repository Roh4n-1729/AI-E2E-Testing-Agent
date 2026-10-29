# Roadmap: real-time AI testing + theme conformance (updated Fri 30 Oct, 03:00)

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

| Pillar                            | Status  | Done                                                                                                                                                       | Missing                                                               |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Real-time AI testing on real apps | ~75%    | real browser and backend, agent + replay + heal, strict evidence judge, API/download/toast/vitals/a11y evidence, settle on aria-busy and in-flight API     | login flows, test data setup/cleanup                                  |
| User-authored tests and flows     | ~40%    | single goal in the UI, JSON suites (CLI), export run → suite                                                                                               | in-UI test case manager                                               |
| Theme conformance                 | v1.1 ✅ | CSSOM discovery, class/attr/media switching, CDP declaration lookup, CIEDE2000 match, leaks, per-theme contrast, Theme tab + report, 3 seeded bugs in eval | DTCG override (optional); first real run on the Presentation Builder  |
| Visual testing                    | ~25%    | per-step screenshots, timeline-based AI visual checks                                                                                                      | baselines, pixel diff + masks, AI diff triage, approve flow           |
| Client attribute contract         | ~50%    | data-testid family, aria-busy, data-aie2e-hint, data-aie2e-reveal                                                                                          | data-aie2e-mask, data-aie2e-component, data-aie2e-theme, TS/JSX types |

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

## Schedule (deadline Mon 2 Nov) · checklist audited against the code, Thu 29 Oct 23:15

**Thu: done.** Agent loop, judge, planner, crawler, parallel runs, reports, record/replay/heal, cursor, local UI
(live view, dark mode, viewer, stop button, heals with old/new selector), quality evidence, app hints, LangGraph,
suites + export, CI workflow, seeded-bug shop + eval (10/10), theme conformance v1, study guide.

Loose ends from Thu (Rohan, on his machine):

- [ ] Delete `tsconfig.json`, `tsconfig.build.json`, `src/core/graph.js`, `tests/graph.test.js`,
      `ui/src/components/Layout.jsx`, `ui/src/components/ResultCard.jsx`
- [ ] `npm install`, `npm run doctor`, `npm test`, `npm run eval`
- [ ] Put `ci.yml` into `.github/workflows/` (cannot be written remotely)
- [ ] `git init`, first commits, push to GitHub
- [ ] `npm run eval -- --mode explore --heal` with the API key: the full-AI numbers have never been measured

**Fri**

- [x] Theme audit on every state the agent reaches (not only the final page)
- [x] Cross-page consistency: near-duplicate looks + `data-aie2e-component` (advisory); seeded `button-drift` → 11/11
- [x] `text-visible` ignores hidden copies (`filter({ visible: true })`), baseline too
- [ ] First real run on the AI Presentation Builder in light and dark; fix what it teaches us
- [ ] Rehearse the demo story on the real app: replay at 0 tokens, a forced self-heal, a wrong expectation failing
- [ ] DTCG token-file override (cut first if Friday runs long)

**Sat**

- [ ] Visual baselines per test step and per theme: pixel diff, `data-aie2e-mask`, approve/reject in the UI
- [ ] Test case manager in the UI (add/edit tests and flows, save as a suite)
- [ ] Login flows: credentials step + saved session (`storageState`)
- [ ] AI triage of visual diffs (cut if behind)
- [ ] Compare two runs in the UI (in KICKOFF, never scheduled; cut if behind)

**Sun**

- [ ] Attribute contract: `data-aie2e-mask`, `data-aie2e-component`, `data-aie2e-theme` + a `.d.ts` for JSX props
- [ ] Reusable GitHub Action (`action.yml`) for other repos; this repo's own CI already exists
- [ ] Third demo app: TodoMVC run
- [ ] Fix `npm run diagrams` on Windows (bash loop) and refresh diagrams (01-04 predate LangGraph; 05 has no PNG)
- [ ] Docs: `CLAUDE.md`, `docs/DECISIONS.md`, `docs/TRADEOFFS.md` (planned in KICKOFF §10, not written yet)
- [ ] README final pass (features, eval incl. full-AI numbers, honest limits)
- [ ] Static showcase on Vercel: study guide, sample report, GIF (pending Rohan's yes)
- [ ] Dockerfile for a long-running host (optional, first to cut)

**Mon:** final evaluation runs, demo GIF, one final run, collect chat transcripts for submission. No new features.

**Cut order if behind:** reference-site/Figma comparison → Playwright spec export → MCP server → AI diff triage.
**Never cut:** strict judge, record/replay/heal, live view, theme conformance v1, evaluation table, honest limits.
