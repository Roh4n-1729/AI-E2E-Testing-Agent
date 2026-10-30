# Demo script (about 8 minutes)

One story, told on apps that run on your laptop, so nothing depends on the venue's network except the LLM
calls in Act 1 and Act 4. Every act has a fallback: a finished run already in the UI's history.

**The story in one line:** _AI writes and repairs the tests, plain Playwright replays them for free, and a strict
judge decides pass or fail from evidence the AI cannot fake._

## Before the interview (15 minutes, once)

`.env`:

```bash
ANTHROPIC_API_KEY=...
AIE2E_USERNAME=standard_user
AIE2E_PASSWORD=secret_sauce        # Sauce Demo's public demo password
```

Three terminals (PowerShell):

```powershell
# T1: the real app (Sauce Demo, http://localhost:4500)
npm run saucedemo

# T2: the tester's UI (http://localhost:4173)
npm run ui

# T3: the seeded-bug shop, for Act 5 (http://localhost:4300)
$env:BUGS="dark-leak"; npm run shop
```

Rehearsal run, so every act has a fallback in the UI history and the baselines are approved:

```powershell
npm start -- run http://localhost:4500 --suite examples/saucedemo/suite.json --no-heal
```

Then, so that Act 1 plans and records live instead of replaying: delete the folders `.aie2e\recordings` and
`.aie2e\plans` (or switch on "Record again" and "Plan again" in the New run form; "Run again" in Act 2 then
replays, it does not repeat those switches). Keep `.aie2e\baselines`.

Browser tabs: the UI, the GitHub Actions page (latest green run), `docs/EVALUATION.md` on GitHub.

## Act 1: the AI tests a real app it has never seen (2 min)

UI → **New run**:

- URL `http://localhost:4500`
- Description: _A shop: log in, browse products, sort them, add to cart, check out._
- Login URL `/`, success text `Products` (credentials come from `.env`, the AI never sees them)
- Max tests 3, 2 in parallel

Say while it runs:

- "It logs in once with plain Playwright, crawls the app, and the planner writes test cases from the site map."
- "Each test gets a fresh browser. The cursor you see is the agent; the live view is a CDP screencast."
- "The agent's own 'I'm done' is recorded but never trusted. The judge reads the DOM, URL, console, network and
  screenshots itself."

Open one passed test: step timeline, screenshots, checks with their evidence, the agent's claim next to the verdict.

_Fallback:_ open the rehearsal run from the history.

## Act 2: replay costs nothing (30 s)

Click **Run again**. Every test says `replay`, the token counter stays at 0, and it finishes in seconds.

- "Passing runs are saved as JSON steps with a test id selector and an XPath fallback. Plain Playwright replays
  them. This is what runs in CI on every push."

## Act 3: same tests, broken users (1.5 min)

T4:

```powershell
$env:AIE2E_USERNAME="problem_user"; npm start -- run http://localhost:4500 --suite examples/saucedemo/suite.json --no-heal
$env:AIE2E_USERNAME="visual_user";  npm start -- run http://localhost:4500 --suite examples/saucedemo/suite.json --no-heal
```

Both runs appear in the UI. Show:

- problem_user: 5 of 6 fail. Open "Sort products by price": the first price is not $7.99. Open "Every product
  shows its own photo": the photo check fails.
- visual_user: open the **Visual** panel: baseline, current, diff. Approve or reject.
- "Sauce Labs built these bugs into their demo app; we did not write them. 0 tokens: it is all replay."

## Act 4: the judge cannot be talked into a pass (1 min)

```powershell
$env:AIE2E_USERNAME="standard_user"; npm start -- run http://localhost:4500 --goal "Add the Sauce Labs Backpack to the cart and open the cart" --expect-text "Sauce Labs Rocket" --login-url / --login-success-text Products
```

The agent adds the backpack and reports success. The judge fails it: the text is not on the page, and the report
flags **agent claim ≠ evidence**.

- "This is the failure mode of naive AI testers: the agent says done, nobody checks."

## Act 5: self-healing that cannot hide a regression (1 min)

```powershell
npm start -- run http://localhost:4500 --suite examples/saucedemo/heal-demo.suite.json
```

The suite was "recorded" against an older test id (`add-to-cart-backpack`). Replay breaks at step 1, the agent
redoes only that step from the live page, the judge runs the same checks, and the report lists the heal with the
old and new selector.

- "If the app were really broken, the healed run would still fail the judge, the cache would not be updated and
  the heal would be marked suspect."

_Fallback:_ `tests/integration/replay.test.js` covers both cases; mention it.

## Act 6: things functional tests never see (1 min)

```powershell
npm start -- run http://localhost:4300 --suite examples/buggy-shop/suite.json --no-heal
```

Open the report → **Theme**: in dark mode the newsletter card is still white. The finding names the CSS rule
Chrome used, the nearest theme token, and a crop of the element. Then the **Consistency** panel.

- "The themes are discovered from the production CSS. No config. `--theme-from` checks one product against
  another product's themes."

## Act 7: proof, not anecdotes (1 min)

- `docs/EVALUATION.md`: 12/12 seeded bugs, 0 false positives, 0 flaky; TodoMVC; Sauce Demo per user.
- GitHub Actions: the clean apps must pass and the seeded regressions must fail, on every push. Job summary from
  the reusable Action.
- `docs/DECISIONS.md` and `docs/IMPROVEMENTS.md`: every real-run failure and what changed.

Close with the honest limits from the README (login without 2FA/SSO, UI only, local or CI, not hosted).

## If something goes wrong

| Problem                  | Do this                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| LLM slow or rate-limited | Open the rehearsal run in the history; continue with Acts 2, 3, 6 (no LLM).                |
| Port already in use      | `$env:PORT=4501; npm run saucedemo` and use that URL everywhere.                           |
| Login fails              | Check `AIE2E_USERNAME` in the current terminal (`echo $env:AIE2E_USERNAME`).               |
| Visual diffs everywhere  | The baselines are from another screen size or zoom: rerun with `--update-baselines` first. |
