import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, startApp, testConfig } from './harness.js';

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

/** @param {boolean} showCursor */
async function open(showCursor) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-cur-'));
  const artifacts = new RunArtifacts(out, 'cur');
  return BrowserSession.open(
    testConfig({ outDir: out, showCursor }),
    artifacts.forTest('t'),
    silentLogger,
  );
}

describe.skipIf(!hasChromium)('visible cursor overlay', () => {
  it('follows the mouse, marks clicks, survives navigation, and never blocks the page', async () => {
    const s = await open(true);
    try {
      await s.goto(`${app.base}/shop`);
      expect(await s.page.locator('#__aie2e_cursor').count()).toBe(1);

      // a real Stagehand click (concrete action, no LLM) moves the cursor onto the button
      await s.stagehand.act({
        selector: 'xpath=//button[@id="add"]',
        method: 'click',
        arguments: [],
        description: 'click add',
      });
      const box = await s.page.locator('#add').boundingBox();
      const pos = await s.page.evaluate(() => /** @type {any} */ (window).__aie2eCursorPos);
      expect(Math.abs(pos.x - (box?.x ?? 0) - (box?.width ?? 0) / 2)).toBeLessThan(3);
      expect(await s.page.locator('#out').textContent()).toBe('Added to cart');

      await s.goto(`${app.base}/about`);
      expect(await s.page.locator('#__aie2e_cursor').count()).toBe(1);
      expect(
        await s.page.locator('#__aie2e_cursor').evaluate((e) => getComputedStyle(e).pointerEvents),
      ).toBe('none');
    } finally {
      await s.close();
    }
  });

  it('glides to its target instead of teleporting, and keeps its place across navigation', async () => {
    const s = await open(true);
    try {
      await s.goto(`${app.base}/shop`);
      await s.page.mouse.move(20, 20);
      await s.page.waitForTimeout(700); // settle at the start point
      /** @param {import('playwright').Page} page */
      const drawn = (page) =>
        page.locator('#__aie2e_cursor').evaluate((e) => {
          const m = new DOMMatrixReadOnly(getComputedStyle(e).transform);
          return { x: m.m41, y: m.m42 };
        });

      await s.page.mouse.move(900, 600); // one event, like an automated click
      await s.page.waitForTimeout(60);
      const mid = await drawn(s.page);
      expect(mid.x).toBeGreaterThan(40); // it has left the start...
      expect(mid.x).toBeLessThan(880); // ...but is not there yet: it is gliding
      await s.page.waitForTimeout(800);
      const end = await drawn(s.page);
      expect(Math.abs(end.x - 900)).toBeLessThan(2);
      expect(Math.abs(end.y - 600)).toBeLessThan(2);

      // after a navigation the new document starts from where the cursor was, not from (0,0)
      await s.goto(`${app.base}/about`);
      const after = await drawn(s.page);
      expect(after.x).toBeGreaterThan(800);
      expect(after.y).toBeGreaterThan(500);
    } finally {
      await s.close();
    }
  });

  it('can be turned off', async () => {
    const s = await open(false);
    try {
      await s.goto(`${app.base}/shop`);
      expect(await s.page.locator('#__aie2e_cursor').count()).toBe(0);
    } finally {
      await s.close();
    }
  });
});
