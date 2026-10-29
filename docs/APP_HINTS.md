# Optional app hints

Nothing here is required. Without hints the agent works from what it sees, and recordings use XPaths.
A few attributes make runs cheaper, replays sturdier, and hover-only or conditional controls findable.

| Attribute                                                                               | What changes                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-testid` (also `data-test-id`, `data-test`, `data-cy`, `data-qa`, `data-aie2e-id`) | Recordings use it instead of an XPath (the XPath is kept as fallback), so replays survive layout changes. The agent gets `appTestIds` / `useTestId` tools to act on it exactly. The planner may assert `selector-visible` on it.                                    |
| `aria-busy="true"`                                                                      | Standard ARIA. The harness waits for it to clear before the next replay step and before judging.                                                                                                                                                                    |
| `data-aie2e-hint="…"`                                                                   | Free text shown to the planner (via the crawl) and to the agent: "Controls appear when the mouse moves to the bottom-right", "Enabled only after a title is set".                                                                                                   |
| `data-aie2e-ignore-theme`                                                               | Leave this element out of the theme audit (third-party widgets, embedded content you do not style).                                                                                                                                                                 |
| `data-aie2e-component="PrimaryButton"`                                                  | Names a component. Every element with the same name must look the same on every screen and in every theme; differences show up in "Consistency across screens" (advisory). Unnamed buttons, links, inputs and headings are still compared for near-duplicate looks. |
| `data-aie2e-reveal="hover"`                                                             | Marks a control that is hidden until hovered. The agent can hover it by test id, which reveals opacity-based toolbars.                                                                                                                                              |

```html
<button data-testid="export-button">Export</button>

<main aria-busy="true">Generating slides…</main>

<div
  class="present-toolbar"
  data-aie2e-reveal="hover"
  data-aie2e-hint="Controls appear when the mouse moves to the bottom-right corner"
>
  <button data-testid="present-next">Next</button>
</div>

<button data-testid="publish" data-aie2e-hint="Enabled only after the deck has a title">
  Publish
</button>
```

## How it is used

- `src/browser/hints.js`: `readHints` lists test ids and hints on the page, hidden ones included (visibility
  uses `checkVisibility`, so a button inside an `opacity: 0` toolbar counts as hidden). `stableSelector` turns
  the element an agent acted on into `[data-testid="…"]`, a close ancestor's test id for clicks, or a
  non-generated `#id`.
- `src/executor/agentExecutor.js`: adds the test-id tools only when the start page has hints, so apps without
  them pay no extra tokens.
- `src/executor/replayExecutor.js`: `resolveTarget` waits for the stable selector or any fallback and uses the
  first one that matches.
- `src/browser/settle.js`: waits on `aria-busy`.
- `src/crawler/bfsCrawler.js` → `src/planner/llmPlanner.js`: test ids and hints appear in the crawl summary.
  `selector-visible` is kept only for test ids the crawl saw.

- `src/theme/audit.js` + `src/theme/consistency.js`: `data-aie2e-ignore-theme` and `data-aie2e-component`.

Tests: `tests/integration/hints.test.js`, `tests/integration/theme.test.js`, `tests/theme.test.js`.
