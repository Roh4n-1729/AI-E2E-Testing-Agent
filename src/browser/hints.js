/**
 * OPTIONAL hints an app can give its testers. None are required: without them everything falls back
 * to AI-driven actions and XPath recordings. With them, runs get cheaper, exact and more stable.
 *
 *  - data-testid (also data-test-id, data-test, data-cy, data-qa, data-aie2e-id)
 *      stable selectors: recordings use them instead of brittle XPaths, the agent can act on them
 *      directly, and the planner may assert on them.
 *  - aria-busy="true"   (a standard ARIA attribute) the harness waits until it clears.
 *  - data-aie2e-hint="…" free-text guidance for the agent, e.g. "Controls appear when the mouse
 *      moves to the bottom-right corner" or "Only enabled after a deck has been generated".
 *  - data-aie2e-reveal="hover" marks a control that is hidden until hovered.
 *
 * @import { Page } from 'playwright'
 */

export const TEST_ID_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
  'data-aie2e-id',
];

/**
 * @typedef {object} PageHint
 * @property {string} [selector]  unique CSS selector built from the test id attribute
 * @property {string} tag
 * @property {string} text  accessible-ish label (aria-label, text, placeholder, title)
 * @property {boolean} visible
 * @property {string} [hint]  data-aie2e-hint
 * @property {string} [reveal]  data-aie2e-reveal
 */

/**
 * Test ids and developer hints on the current page, INCLUDING hidden ones (that is the point:
 * a toolbar that only shows on hover is still listed). Capped at 80 entries.
 * @param {Page} page @returns {Promise<PageHint[]>}
 */
export async function readHints(page) {
  return page
    .evaluate((attrs) => {
      const sel = [...attrs.map((a) => `[${a}]`), '[data-aie2e-hint]', '[data-aie2e-reveal]'].join(
        ',',
      );
      /** @type {any[]} */
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        if (out.length >= 80) break;
        const attr = attrs.find((a) => el.hasAttribute(a));
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        // checkVisibility also accounts for ancestors (a button inside an opacity:0 toolbar is hidden)
        const visible =
          r.width > 0 &&
          r.height > 0 &&
          (typeof el.checkVisibility === 'function'
            ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
            : cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05);
        const he = /** @type {HTMLElement} */ (el);
        const text = (
          el.getAttribute('aria-label') ||
          he.innerText ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        out.push({
          selector: attr ? `[${attr}=${JSON.stringify(el.getAttribute(attr))}]` : undefined,
          tag: el.tagName.toLowerCase(),
          text,
          visible,
          hint: el.getAttribute('data-aie2e-hint') || undefined,
          reveal: el.getAttribute('data-aie2e-reveal') || undefined,
        });
      }
      return out;
    }, TEST_ID_ATTRS)
    .catch(() => []);
}

/**
 * A selector for the element at `xpath` that survives layout changes: its own test id, a test id on
 * a close ancestor (clicks often land on an inner <span>; only for click-like methods), or a
 * non-generated unique id. Null when there is none (the XPath stays the selector).
 * @param {Page} page @param {string} xpath @param {string} method
 * @returns {Promise<string | null>}
 */
export async function stableSelector(page, xpath, method) {
  const xp = xpath.replace(/^xpath=/, '');
  return page
    .evaluate(
      ({ xp, attrs, climb }) => {
        const el = document.evaluate(
          xp,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue;
        if (!el || el.nodeType !== 1) return null;
        const unique = (/** @type {string} */ s) => {
          try {
            return document.querySelectorAll(s).length === 1;
          } catch {
            return false;
          }
        };
        let n = /** @type {Element | null} */ (el);
        for (let depth = 0; n && depth <= (climb ? 3 : 0); n = n.parentElement, depth++) {
          for (const a of attrs) {
            const v = n.getAttribute(a);
            if (v && unique(`[${a}=${JSON.stringify(v)}]`)) return `[${a}=${JSON.stringify(v)}]`;
          }
        }
        const id = /** @type {Element} */ (el).id;
        // skip generated ids (React useId ":r1:", "radix-123", "ember456")
        if (id && !/\d{3,}|:/.test(id) && unique(`#${CSS.escape(id)}`)) return `#${CSS.escape(id)}`;
        return null;
      },
      { xp, attrs: TEST_ID_ATTRS, climb: ['click', 'doubleClick', 'hover'].includes(method) },
    )
    .catch(() => null);
}

/** Compact text for prompts. @param {PageHint[]} hints */
export function describeHints(hints) {
  return hints
    .map(
      (h) =>
        `${h.selector ?? h.tag} "${h.text}"${h.visible ? '' : ' (currently hidden)'}${h.reveal ? ` [reveal: ${h.reveal}]` : ''}${h.hint ? ` hint: ${h.hint}` : ''}`,
    )
    .join('\n');
}
