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
  const { x, y } = await toPixels(page, xPercent, yPercent);
  await page.mouse.move(x, y, { steps: 14 });
  // a nudge: some UIs only reveal controls on movement inside the target area, not on arrival
  await page.mouse.move(Math.max(0, x - 6), Math.max(0, y - 4), { steps: 3 });
  await page.waitForTimeout(250);
}

/** A viewport position in percent, as pixels. @param {Page} page @param {number} xPercent @param {number} yPercent */
async function toPixels(page, xPercent, yPercent) {
  const vp =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const clamp = (/** @type {number} */ n) => Math.min(100, Math.max(0, n));
  return {
    x: (clamp(xPercent) / 100) * (vp.width - 1),
    y: (clamp(yPercent) / 100) * (vp.height - 1),
  };
}

/**
 * Press at one point, move in small steps, release at another: crop handles, sliders, drag-to-reorder, drawing.
 * Positions are percentages of the viewport, so the step replays at the same place. Shared by the agent's
 * `dragAt` tool and the replay of its step.
 * @param {Page} page @param {number} fromX @param {number} fromY @param {number} toX @param {number} toY
 */
export async function dragPercent(page, fromX, fromY, toX, toY) {
  const a = await toPixels(page, fromX, fromY);
  const b = await toPixels(page, toX, toY);
  await page.mouse.move(a.x, a.y, { steps: 8 });
  await page.mouse.down();
  // a first small move: many drag libraries only start a drag after the pointer moved a few pixels
  await page.mouse.move(a.x + (b.x > a.x ? 4 : -4), a.y + (b.y > a.y ? 4 : -4), { steps: 2 });
  await page.mouse.move(b.x, b.y, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}
