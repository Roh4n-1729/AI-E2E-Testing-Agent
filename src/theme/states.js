/**
 * @import { Page } from 'playwright'
 * @import { ThemeAudit, ThemeState } from '../core/types.js'
 */

/**
 * Runs in the page: a cheap, content-independent fingerprint of "which screen is this".
 * Two moments with the same fingerprint are the same state for the theme audit, so it only runs once.
 *  - the route (path + hash route), with ids normalised (/deck/42 and /deck/43 are one screen)
 *  - open overlays (dialogs, menus, listboxes), which bring their own surfaces
 *  - the visible landmarks (header, nav, main, aside, footer, form, table, tab panels)
 *  - the visible test ids, digits normalised (slide-3 = slide-4)
 * Text is deliberately left out: AI apps generate new content on every run.
 */
export function stateFingerprint() {
  const norm = (/** @type {string} */ p) =>
    p
      .split('/')
      .map((s) => (/^\d+$|^[0-9a-f-]{8,}$/i.test(s) ? ':id' : s))
      .join('/');
  const vis = (/** @type {Element} */ el) =>
    typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      : /** @type {HTMLElement} */ (el).offsetParent !== null;
  const route = `${location.origin}${norm(location.pathname)}${location.hash.startsWith('#/') ? norm(location.hash) : ''}`;
  const overlays = Array.from(
    document.querySelectorAll(
      'dialog[open], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [aria-modal=true]',
    ),
  )
    .filter(vis)
    .slice(0, 4)
    .map((o) => o.getAttribute('role') || o.tagName.toLowerCase());
  const landmarks = new Set(
    Array.from(
      document.querySelectorAll('header, nav, main, aside, footer, form, table, [role=tabpanel]'),
    )
      .filter(vis)
      .map((e) => (e.getAttribute('role') === 'tabpanel' ? 'tabpanel' : e.tagName.toLowerCase())),
  );
  const ids = new Set(
    Array.from(document.querySelectorAll('[data-testid],[data-test],[data-cy],[data-qa]'))
      .filter(vis)
      .map((e) =>
        (
          e.getAttribute('data-testid') ??
          e.getAttribute('data-test') ??
          e.getAttribute('data-cy') ??
          e.getAttribute('data-qa') ??
          ''
        ).replace(/\d+/g, '#'),
      ),
  );
  return [
    route,
    overlays.sort().join(','),
    [...landmarks].sort().join(','),
    [...ids].sort().slice(0, 40).join(','),
  ].join('|');
}

/**
 * Run-wide memory of the states the theme audit has seen. Tests that reach the same screen share one
 * audit (the result is reused, marked `reusedFrom`), and the total number of fresh audits is capped so
 * a long agent run on a content-heavy app cannot spend minutes auditing.
 */
export class ThemeStates {
  /** @type {Map<string, Promise<ThemeState | null>>} */
  #byKey = new Map();
  #fresh = 0;

  /**
   * @param {{ perTest?: number, perRun?: number }} [o]
   *   perTest: audits of in-between states per test (the final state is always covered);
   *   perRun: fresh audits per run, in-between and final together.
   */
  constructor({ perTest = 3, perRun = 30 } = {}) {
    this.perTest = perTest;
    this.perRun = perRun;
  }

  /** States audited so far, deduplicated. */
  get audited() {
    return this.#fresh;
  }

  /**
   * Audit this state unless the run already did; returns the (possibly shared) result.
   * @param {string} key  from `stateFingerprint`
   * @param {{ testId: string, label: string, url: string, step?: number, final: boolean }} at
   * @param {() => Promise<ThemeAudit>} audit
   * @returns {Promise<ThemeState | null>} null when the cap is reached
   */
  async visit(key, at, audit) {
    const seen = this.#byKey.get(key);
    if (seen) {
      const s = await seen;
      return s
        ? {
            ...s,
            label: at.label,
            url: at.url,
            step: at.step,
            reusedFrom: s.reusedFrom ?? { testId: s.testId, label: s.label },
            testId: at.testId,
          }
        : null;
    }
    if (this.#fresh >= this.perRun && !at.final) return null;
    this.#fresh++;
    const p = audit().then(
      (a) =>
        /** @type {ThemeState} */ ({
          key,
          testId: at.testId,
          label: at.label,
          url: at.url,
          step: at.step,
          audit: a,
        }),
      () => null,
    );
    this.#byKey.set(key, p);
    return p;
  }
}

/**
 * @param {Page} page
 * @returns {Promise<string | null>}
 */
export const fingerprintOf = (page) => page.evaluate(stateFingerprint).catch(() => null);
