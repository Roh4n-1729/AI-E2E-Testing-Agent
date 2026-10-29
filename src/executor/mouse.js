/**
 * @import { Page } from 'playwright'
 */

/**
 * Move the real mouse (no click) to a point given as percentages of the viewport, in small steps so
 * the page sees a normal pointer movement (hover menus and auto-hiding toolbars react to that) and
 * the on-screen cursor glides there. Shared by the agent's `hoverAt` tool and the replay of its step.
 * @param {Page} page @param {number} xPercent @param {number} yPercent
 */
export async function moveMouseToPercent(page, xPercent, yPercent) {
  const vp =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const clamp = (/** @type {number} */ n) => Math.min(100, Math.max(0, n));
  const x = (clamp(xPercent) / 100) * (vp.width - 1);
  const y = (clamp(yPercent) / 100) * (vp.height - 1);
  await page.mouse.move(x, y, { steps: 14 });
  // a nudge: some UIs only reveal controls on movement inside the target area, not on arrival
  await page.mouse.move(Math.max(0, x - 6), Math.max(0, y - 4), { steps: 3 });
  await page.waitForTimeout(250);
}
