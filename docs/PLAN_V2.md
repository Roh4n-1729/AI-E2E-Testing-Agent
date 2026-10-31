# Plan v2: a product people outside engineering can use (Fri 30 Oct, 13:45)

Goal: keep everything that works today, and add (1) a refined, presentation-quality UI for non-developers next to
the existing developer view, (2) the best models for the browser agent and the judge, (3) explicit tools so the
agent, the browser harness and the judge share what they know, and (4) the correctness fixes the Asset Sense run
exposed. Deadline unchanged: Mon 2 Nov. No auth. **Shared as** (section P5): a static showcase on Vercel that always
works, plus the live demo from the laptop over the call.

## 1. What I checked

### The Asset Sense run (Rohan's screenshots)

| What you see                                                         | Cause                                                                                                                                                                                        | Fix (phase) |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| A wall of theme text listing 10 "themes"                             | **Bug:** theme discovery treats Tailwind utility classes (`.bg-slate-100`, `.bg-white`, `.bg-violet-600` …) as themes, because they set `--tw-*` CSS variables. Real themes: light and dark. | P0          |
| The same finding repeated per theme and per screen                   | Findings are listed per theme × screen instead of grouped by problem.                                                                                                                        | P0          |
| "Minified React error #425 … or use t"                               | Raw console text, cut mid-word. #425 is a React hydration mismatch: a real bug in the app (server and browser render different text), worth explaining in plain English.                     | P0          |
| Agent clicked "Explore Now", went back, clicked it again             | The planned goal was ambiguous ("the third Explore Now button") and the agent cannot see what the harness sees (console errors, the server error page).                                      | P1 (tools)  |
| Agent claimed success on a server error page                         | Caught correctly (claim ≠ evidence), but the agent had no way to know it was an app error.                                                                                                   | P1 (tools)  |
| Planning screen: three grey boxes for a minute                       | The UI only learns about tests after planning; crawl results and planner progress are not streamed.                                                                                          | P2          |
| Steps: tiny thumbnails, a long list, no sense of where the user went | The step list is a log, not a journey.                                                                                                                                                       | P2          |
| Verdict, checks and warnings in one long scrolling block             | One layout for every reader; developer detail is always expanded.                                                                                                                            | P2          |

### Models today

| Role                                          | Called through            | Can use the newest Claude models?                                                                                                                                   |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planner (`AIE2E_PLANNER_MODEL`)               | Vercel AI SDK             | **Yes**, any model id (e.g. `anthropic/claude-sonnet-5-5`, `claude-opus-5-5`)                                                                                       |
| Judge, visual questions (`AIE2E_JUDGE_MODEL`) | Vercel AI SDK             | **Yes**, any model id                                                                                                                                               |
| Browser agent (`AIE2E_MODEL`)                 | Stagehand 3.7.3 `agent()` | Only models in Stagehand's list: up to `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-fable-5`. 5.5 models break its loop (thinking signatures), seen on Thursday. |

**Stagehand 4.x** (4.3.0, 20 Oct) accepts new model ids, but its migration guide says **`agent()` is removed with no
one-for-one replacement**; also `init()` → `Stagehand.create()`, `act/observe/extract` return `{ data, metadata }`,
pages move to `browser.context`. Our agent loop, step callbacks, custom tools and healing are built on `agent()`.
Moving to v4 means writing our own agent loop (AI SDK tool calling + v4 `act`/`observe`), which would also give us
any model and our own tools natively. Worth it, but a rewrite of the riskiest part two days before the deadline.

### How the agent, the browser and the judge talk today

```
          goal (text)                       actions (act, ariaTree, screenshot, scroll, hoverAt, useTestId)
Planner ───────────────▶ Agent (Stagehand) ─────────────────────────────────────────────▶ Browser
                            │  claim (free text, "success": true/false)                     │
                            ▼                                                               │ Playwright listeners:
                         Judge ◀────────────────────────── evidence ◀───────────────────────┘ console, network, URL,
                    (deterministic checks + one-shot LLM question on screenshots)            screenshots, theme, a11y
```

The agent never sees the harness's evidence (console errors, failed requests), so it cannot tell "I failed" from
"the app failed". Its claim is free text. The visual judge answers one question from screenshots only, so it
sometimes misreads a page whose text would have settled the question.

**Answer to "should we define tools?" Yes, three, all bounded, none able to change a verdict:**

1. **`harness_status` (agent, read-only):** current URL, console errors and failed requests since the test
   started, whether the page shows an error state. The agent can then stop early on an app error (fewer tokens)
   and say so. The judge still decides from its own evidence (asymmetric trust stays).
2. **Structured finish (agent):** Stagehand 3.7.3 supports an `output` schema on `execute()`. The agent ends with
   `{ status: done | blocked | app-error, summary, whatISaw[] }` instead of prose, which the UI can show cleanly
   and the judge can compare field by field.
3. **Evidence tools for the visual judge (read-only, max 3 calls):** `pageText()`, `findText(text)`,
   `elementState(selector)`. The judge grounds a yes/no answer in the DOM, not only pixels, and cites what it read.

No MCP server is needed: these are in-process tools (Stagehand custom tools for the agent, AI SDK tools for the
judge). An MCP layer stays on the roadmap for exposing the whole tester to other AI tools.

## 2. Ground rules so nothing we built breaks

- **A branch per phase** (`fix/p0-theme`, `feat/models-tools`, `feat/ui-v2`, `spike/stagehand-v4`). `main` only gets
  a phase when it passes `npm run check`, lint, prettier, all tests (109 today), the suite evaluation (12/12), and
  CI on GitHub.
- **Additive only:** `report.json`, the server API and suite files only gain fields; old reports still open.
- **Both views:** the current developer view stays, as "Developer details" inside the new pages and as a
  "Classic" toggle until the new view has passed its own tests and a rehearsal.
- **Dogfooding:** the new UI gets a committed suite run by our own tool (visual baselines included).
- **Models behind config:** new defaults are presets; anyone can still pin the old models.
- **The Stagehand v4 work is a spike on its own branch.** It merges only if it beats 3.7.3 on our evaluations.

## 3. Phases

### P0 · Correctness fixes (Fri afternoon, ~2 h) · **done 14:30**

- Theme discovery: a class or attribute counts as a theme only if it overrides tokens the base theme defines;
  ignore framework variables (`--tw-*`). Unit tests with Tailwind v3 and v4 CSS.
- Group findings by problem ("hard-coded #730000 at 43% in the header button: light and dark, 2 screens")
  instead of one line per theme × screen.
- Error explainer: decode minified React errors (#418/#423/#425 hydration, #310 hooks …) into plain English with
  the React link; never cut text mid-word.
- Gate: tests + suite evaluation unchanged, the Asset Sense report shows 2 themes.

### P1 · Best models + the three tools (Fri evening / Sat morning, ~4 h) · **done 15:45**

Built as planned except the judge: page text is given as context in the same single call instead of a tool loop
(one yes/no question does not need several calls). See IMPROVEMENTS.

- **Model presets by role**, chosen in the New run form and `.env`:

  | Preset   | Agent (Stagehand 3.7.3)           | Planner + judge (AI SDK) | Use              |
  | -------- | --------------------------------- | ------------------------ | ---------------- |
  | Economy  | `claude-haiku-4-5`                | `claude-haiku-4-5`       | CI, many runs    |
  | Balanced | `claude-haiku-4-5`                | `claude-sonnet-5-5`      | default          |
  | Best     | `claude-sonnet-4-6` or `opus-4-8` | `claude-opus-5-5`        | demos, hard apps |

  The UI shows the estimated cost per run from the token counts we already record. `doctor` checks that the chosen
  agent model is one Stagehand knows.

- `harness_status` tool, structured finish, judge evidence tools (above), each with tests using the mock LLM.
- Planner: goals must name elements unambiguously (label + section), never "the third button".
- Gate: AI evaluation on the shop and one Sauce Demo AI run, compared with today's numbers.

### P2 · UI v2: refined views for everyone (Sat, the main block) · **done Fri 17:00**

**Design first (1 h):** mockups of the four screens below as a Design artifact for Rohan to approve before any
code. Direction: calm, data-dense like Linear or Vercel, one accent colour, real screenshots large, plain language
first and raw detail one click away.

1. **Layout:** full-height shell; sidebar, page header with run status and actions; content in a two-pane layout
   (list + detail) with independent scrolling, so nothing scrolls the whole page.
2. **Run summary (for anyone):** a headline sentence ("6 of 8 flows work · 2 problems found · 0 tokens, replayed in
   41 s"), KPI tiles, **Findings** grouped by severity and kind in plain English (functional, error,
   accessibility, theme, visual, performance), each linking to the test and step where it was seen; tests table
   with status, how it ran (AI / replay / healed), duration and cost.
3. **Test detail as a journey:**
   - **Flow strip:** the pages the test visited as connected nodes (Home → Tagging → …) with the action on each
     edge, loops visible (the "Explore Now, back, Explore Now" pattern above becomes obvious).
   - **Story steps:** each step as a sentence ("Clicked Explore Now · went to /tagging · 1 console error") with a
     large screenshot, before/after toggle, and what the harness noticed at that step (errors, requests, theme
     problems).
   - **Verdict card:** one plain-English sentence, then the checks as pass/fail chips with their evidence; the
     agent's structured report next to it.
   - **Developer details** drawer: today's tabs (checks, network, console, theme, visual, quality, raw JSON).
4. **Live run:** the crawl streams pages as they are found (thumbnails), the plan shows tests as they are written
   and what the plan review fixed; then the live browser with the current step's sentence.
5. **Shareable report:** `report.html` gets the same summary and journey views (self-contained, light/dark), so a
   run can be sent to someone who never installs the tool.
6. Run history and suites restyled to the same system; the classic view stays behind a toggle.

Gate: UI tests updated plus the new dogfood suite; Rohan reviews in the browser; demo rehearsal on the new UI.

**Done Fri 17:00** (see IMPROVEMENTS): summary, journey, live run, run list, sidebar models, report.html parity,
labels on checks, `reporter/insights.js`. Not built: the filmstrip toggle and crawl thumbnails (the crawler takes no
screenshots; adding them costs a screenshot per page for little gain). Remaining gate: Rohan's review in the
browser and a demo rehearsal on the new screens.

### P3 · Stagehand v4 spike (Sat, time-boxed 3 h, branch only) · **done Fri 19:00, different outcome**

**Outcome:** Stagehand 4.3.0 launches locally and Playwright attaches over CDP, but v4 runs through a browser
extension and has no `agent()`, so the real work was always "our own loop". Built that instead, behind a setting:
`AIE2E_AGENT_ENGINE=loop` (D31). The model reads `page.ariaSnapshot({ mode: 'ai' })` with element refs, acts by
ref, and every action is recorded as Playwright's own locator (`locator.normalize()`), so replay and healing are
unchanged. Any model id works (the 5.5 family included). Tested offline with a scripted model on a real page,
including replaying the recording. **Still to decide (needs your key):** run Sauce Demo and the shop in explore
mode with `loop` + sonnet-5-5 vs `stagehand` + haiku-4-5, compare pass rate, false failures, tokens and time; make
`loop` the default only if it is at least as good. Stagehand stays the default until then.

Original plan:

Our own agent loop: AI SDK `generateText` with tools (`act`, `observe`, `extract` from Stagehand v4, plus
`hoverAt`, test-id tools and `harness_status`), step events from our loop, any model id including the 5.5 family.
**Decision on Sat evening:** merge only if replay, healing and the Sauce Demo and shop AI runs are at least as good;
otherwise it is roadmap, documented in TRADEOFFS with what the spike learned.

### P4 · Finish (Sun, after P5) · **README and DEMO.md done Fri 20:30; GIF and final CI left**

README with screenshots of the new UI, demo script updated for the new screens, the demo GIF, AI evaluation numbers
in the README, final CI run. Mon: final run and transcripts only.

### P5 · Share it: Vercel showcase + live demo from the laptop (Sun morning, ~3 h) · **showcase built Sat 07:30**

Decided Fri 14:30: no Docker host. The interview is a call, so the live part runs on Rohan's laptop (screen share),
and a Vercel link lets anyone explore real results before or after the call.

| Part          | Where                        | What it does                                                                                                                                                                                                                                                         |
| ------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Showcase**  | Vercel, static, free         | The real UI v2 in **demo mode**: it reads recorded runs (shop evaluation, TodoMVC, every Sauce Demo user, an AI run with planning, healing and the plan review). Every screen, screenshot and finding is clickable; nothing can fail. Study guide and docs included. |
| **Live demo** | Rohan's laptop, screen share | The full tool following `docs/DEMO.md`: the AI agent live on Sauce Demo, replay at 0 tokens, a heal, the strict judge, a theme finding.                                                                                                                              |

**Later, at the very end (kept, not cut):** a guarded live server (Docker image on a host such as Railway) so the
tool can be tried without the laptop: bundled demo apps only by default, replays without a key, visitors' own
key for AI runs, one run at a time. Needs a host account; built only after everything above is done.

Not exposing the laptop to the internet (a tunnel): the local server refuses non-local hosts on purpose (DNS
rebinding guard) and holds the API key; screen sharing needs neither.

Work: a static API adapter in the UI (`VITE_DEMO=1`) that reads `demo/*.json` plus exported run folders from a new
`npm run demo:export`; `vercel.json` for the static build; a "Demo data: recorded runs" banner; README with the link.
Gate: the Vercel URL opens on a phone and a laptop with no console errors (checked by our own tool).

## 4. Fallback order (only used if something slips)

Nothing is cut. The plan is about 28–30 hours of work against about 36 available before Sunday night; this
order only decides what moves last if a real run exposes something new (as the AI evaluations did today):
Stagehand v4 spike → coverage map and before/after toggle → live crawl thumbnails →
`report.html` parity → judge evidence tools. **Never cut:** P0 fixes, the run summary and journey view, the
harness_status tool, the model presets, **the Vercel showcase**, everything that already works.

## 5. Still open from before

- CI run #3 overall status (only the shop job was confirmed green).
- AI evaluation rerun with the plan review and a stronger planner model.
- Demo rehearsal and GIF; final README numbers; chat transcripts for submission.

## 6. Decisions for Rohan

1. Approve the phases and the order (P0 → P1 → P2, with P3 as a time-boxed spike)?
2. Default model preset: Balanced (cheap agent, strong planner and judge) or Best?
3. Run the Stagehand v4 spike at all, or put it straight on the roadmap?
4. Product name and tagline for the pitch-ready UI (today: "AI E2E Agent").
5. ~~Deployment~~ decided: Vercel showcase + live demo on the laptop over the call.
