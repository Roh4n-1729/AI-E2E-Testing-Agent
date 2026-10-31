# Demo script (about 10 minutes)

One story, told mostly in the web UI, on apps that run on your laptop plus one real deployed app. Every act has a
fallback: a finished run already in the UI's history.

**The story in one line:** _AI writes and repairs the tests, plain Playwright replays them for free, a strict judge
decides pass or fail from evidence the AI cannot fake, and the report reads like a person wrote it for anyone._

## Models: cheap while building, best for the demo

| When                   | Setting                                         | Agent      | Planner and judge | Cost per AI-driven test |
| ---------------------- | ----------------------------------------------- | ---------- | ----------------- | ----------------------- |
| Building, rehearsing   | `.env`: `AIE2E_PRESET=economy`                  | haiku-4-5  | haiku-4-5         | a few cents             |
| The demo               | New run → **Models: Best** (or `--preset best`) | sonnet-4-6 | opus-5-5          | about $0.30–0.60        |
| Any model as the agent | New run → **Browser agent: Own loop**           | any        | as the preset     | depends on the model    |

A preset chosen in the form or with `--preset` beats the models in `.env` for that run only; every run prints its
models first (`Models (best): agent claude-sonnet-4-6, planner claude-opus-5-5, judge claude-opus-5-5`). Replays cost
nothing whatever the preset.

## Before the interview (20 minutes, once)

`.env`:

```bash
ANTHROPIC_API_KEY=...
AIE2E_PRESET=economy
AIE2E_USERNAME=standard_user
AIE2E_PASSWORD=secret_sauce        # Sauce Demo's public demo password
```

Three terminals (PowerShell):

```powershell
# T1: the real app (Sauce Demo, http://localhost:4500)
npm run saucedemo

# T2: the tester's UI (http://localhost:4173)
npm run ui

# T3: the seeded-bug shop, for Act 6 (http://localhost:4300)
$env:BUGS="dark-leak"; npm run shop
```

Rehearsal, so every act has a fallback in the history and the screenshot baselines are approved:

```powershell
node src/cli/main.js run http://localhost:4500 --suite examples/saucedemo/suite.json --no-heal
$env:AIE2E_USERNAME="problem_user"; node src/cli/main.js run http://localhost:4500 --suite examples/saucedemo/suite.json --no-heal
$env:AIE2E_USERNAME="standard_user"
node src/cli/main.js run https://asset-sense-6fom.vercel.app/ --preset best --max-tests 3 --replan --rerecord
```

Then, so that Act 1 plans and records live: in the New run form switch on **Record again** and **Plan again**
("Run again" in Act 2 replays; it does not repeat those switches). Keep `.aie2e\baselines`.

Browser tabs: the UI, the GitHub Actions page (latest green run), the Vercel showcase, `docs/EVALUATION.md`.

## Act 1: the AI tests an app it has never seen (2 min)

UI → **New run**:

- URL `http://localhost:4500`
- Description: _A shop: log in, browse products, sort them, add to cart, check out._
- Login URL `/`, success text `Products` (credentials come from `.env`; the AI never sees them)
- Planned tests 3 · **Models: Best** · Record again · Plan again

Before pressing **Start testing**: "The right side says what will happen, filled in from this form: Playwright
logs in and explores, the planner writes the tests, the agent runs them, the judge decides. Each AI step names its
model."

While it runs (the **live run** screen):

- "Five stages: it logs in once with plain Playwright, explores the app, plans tests, runs each in its own
  browser, and writes the report. The cards at the top are those stages."
- "This is the browser the agent is driving, streamed live. The line under it is what it is doing right now."
- "Before anything ran, the plan review compared every check with what the crawl saw: a check that is already true
  on the start page, or wording the app never showed, proves nothing. That card shows what it fixed."

When it finishes, the **run summary**: the verdict sentence, the four numbers, the tests table. Open a test: the
**journey** (where the user went, the steps by page, why it passed).

_Fallback:_ open the rehearsal run.

## Act 2: replay costs nothing (30 s)

**Run again**. Every test says _Replay_, the AI cost stays at 0 tokens, it finishes in seconds.

- "Passing runs are saved as steps with stable selectors. Plain Playwright replays them; this is what CI runs on
  every push."

## Act 3: the same tests, a broken user (1.5 min)

Open the rehearsal run for **problem_user** from the history.

- The headline: _"4 problems found · 1 of 6 flows work for problem_user."_
- **What is wrong**: "2 flows get stuck on Checkout step one. The page shows 'Error: Last Name is required'." Click
  _Place an order_.
- The **journey**: Inventory → Cart → **Checkout step one (stuck here)** ⇢ Checkout complete (never reached). Step 9
  in red: _Click Finish: it never appeared (waited 8 s)_. **Why it failed** stays in view on the right.
- **AI's reading** (when the run had a key): the likely cause in plain words, labelled as the AI's reading; it never
  changes the result.
- **Who did what**: the filter above the steps. _Playwright_ shows the 8 steps it replayed and that they came from
  the suite; _Judge_ shows the checks it used, the test's own and the ones added to every test; _AI agent_ is
  empty, because no AI ran. On an AI run, _AI agent_ shows the exact instruction the agent got.
- **Looks different**: approved vs now vs changed pixels; _Approve new look_ / _Keep the old one_.
- "Sauce Labs built these bugs into their demo; we did not write them. 0 tokens: it is all replay."

## Act 4: real deployed apps (2 min)

**The presentation builder** (`ai-presentation-builder-eosin.vercel.app`, Best models, 8 planned tests; rehearsal run
`20261031031448-f7d8` or newer):

- The planner covered 8 features from one start page and a description: generate, suggestion, sample deck, blank
  deck, edit, add a slide, theme, present.
- The headline problem: _"A server request fails and breaks 4 flows that otherwise work"_. `POST /api/describe`
  returns 502 after the sample deck opens. Four flows did their job; the judge still fails them, and the summary
  names the one cause.
- _Start a blank deck_: the AI's reading says it is a problem with the test (the app makes an empty deck by
  design), so it is listed to review, not as an app bug.

**Asset Sense:**

Open the rehearsal **Asset Sense** run (`asset-sense-6fom.vercel.app`, Best models).

- The app's own bugs, found without a script: React hydration errors on every page (explained in plain English),
  a request to `/[object Module]` that returns 404, the community page that never loads.
- _"Goal reached, but the app logged errors"_: the tool tells a working flow on a noisy app apart from a broken flow.
- A test where the agent clicked the wrong one of three "Explore Now" buttons and called it success: the judge
  failed it from the URL and the screenshots, and the AI's reading says _"clicked the wrong Explore Now button… a
  problem with the test, not the app"_.
- "This is why the judge exists, and why the explanation says when the test itself is wrong."

## Act 5: the judge cannot be talked into a pass (1 min)

```powershell
node src/cli/main.js run http://localhost:4500 --goal "Add the Sauce Labs Backpack to the cart and open the cart" --expect-text "Sauce Labs Rocket" --login-url / --login-success-text Products
```

The agent adds the backpack and reports success. The judge fails it: the text is not on the page. In the UI the
journey shows the agent's report next to the evidence: **contradicted by the evidence**.

- "The failure mode of naive AI testers: the agent says done, nobody checks."

## Act 6: self-healing that cannot hide a regression, and things functional tests never see (1.5 min)

```powershell
node src/cli/main.js run http://localhost:4500 --suite examples/saucedemo/heal-demo.suite.json
node src/cli/main.js run http://localhost:4300 --suite examples/buggy-shop/suite.json --no-heal
```

- Heal: the suite was recorded against an old test id. Replay breaks at step 1, the agent redoes only that step,
  the judge runs the same checks, and the summary lists _"1 recording was out of date and repaired by the AI"_.
- Theme: in dark mode the newsletter card stays white. **Developer details → Theme** names the CSS rule, the nearest
  theme token and a crop of the element.

## Act 7: under the hood, and proof (1 min)

- **Two agent engines**: Stagehand (default) and our own loop on Playwright's accessibility tree, which takes any
  model and clicks the exact element it saw. "Stagehand 4 removed its agent, so the loop had to become ours."
- **Where AI is and is not used**: planner, agent, `visual` checks, the AI's reading of failures. Everything else,
  including the verdict and the report wording, is deterministic.
- `docs/EVALUATION.md` (12/12 seeded bugs, 0 false positives), GitHub Actions (clean apps pass, seeded regressions
  fail, on every push), `docs/DECISIONS.md` and `docs/IMPROVEMENTS.md`.
- **Developer view** toggle: the original tabs for engineers, one click away.

Close with the honest limits from the README.

## The showcase (Vercel, read-only)

A link the interviewer can open before or after the call: the same UI over real runs, exported as static files.
Nothing can be started there, so it cannot fail and holds no keys.

```powershell
# 1. pick the runs (ids are in the UI's URL: #/runs/<id>): the presentation builder and Asset Sense (Best),
#    TodoMVC (both engines), Sauce Demo as standard_user and problem_user
npm run demo:export -- --runs 20261031031448-f7d8,20261030111859-a09b,20261030105506-e080,20261030105946-f2c7,<sauce standard>,<sauce problem>
# 2. build the UI in showcase mode (reads .aie2e/showcase, writes ui/dist-demo)
npm run demo:build
# 3. deploy the folder (first time: log in and accept the project name)
npx vercel deploy ui/dist-demo --prod
```

Re-export and redeploy whenever you want newer runs on it. Look at what you publish: URLs, usernames (never
passwords) and screenshots of the apps are in the reports.

## If something goes wrong

| Problem                  | Do this                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| LLM slow or rate-limited | Open the rehearsal runs; continue with Acts 2, 3, 4, 6 (replays and saved runs, no LLM).   |
| Wrong models in a run    | Check the first log line; pick **Best** in the form (it beats `.env`).                     |
| Port already in use      | `$env:PORT=4501; npm run saucedemo` and use that URL everywhere.                           |
| Login fails              | Check `AIE2E_USERNAME` in the current terminal (`echo $env:AIE2E_USERNAME`).               |
| Visual diffs everywhere  | The baselines are from another screen size or zoom: rerun with `--update-baselines` first. |
| No network on the call   | The Vercel showcase has every run above, read-only.                                        |
