/**
 * @import { Page } from 'playwright'
 */

/**
 * Wait until the page stops changing, capped at `maxMs`. "Stopped" means, for `quietMs` in a row:
 *  - the URL and the amount of visible text are unchanged,
 *  - no element says it is busy (`aria-busy="true"`, the standard way apps announce loading), and
 *  - no fetch/XHR is in flight (when the caller can tell, via `inflight`).
 * Apps never have to cooperate, but if they set `aria-busy` the wait becomes exact.
 * @param {Page} page
 * @param {{ maxMs: number, quietMs: number }} o
 * @param {() => number} [inflight]  open fetch/XHR requests right now
 * @returns {Promise<boolean>} true if the page settled, false if the cap was hit
 */
export async function settle(page, { maxMs, quietMs }, inflight = () => 0) {
  const deadline = Date.now() + maxMs;
  await page.waitForLoadState('domcontentloaded', { timeout: maxMs }).catch(() => undefined);
  let last = '';
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const snap = await page
      .evaluate(() => ({
        key: `${location.href}|${document.body?.innerText.length ?? 0}`,
        busy: !!document.querySelector('[aria-busy="true"]'),
        empty: (document.body?.innerText.trim().length ?? 0) === 0,
      }))
      .catch(() => ({ key: '', busy: false, empty: true }));
    // an empty page is never "settled": SPAs render after the load event
    const moving = snap.key !== last || snap.busy || snap.empty || inflight() > 0;
    if (moving) {
      last = snap.key;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) return true;
    await page.waitForTimeout(150);
  }
  return false;
}
