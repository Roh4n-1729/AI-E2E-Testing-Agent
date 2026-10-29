import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readHints, stableSelector } from '../../src/browser/hints.js';
import { BrowserSession } from '../../src/browser/session.js';
import { testIdTools } from '../../src/executor/agentExecutor.js';
import { runStep } from '../../src/executor/replayExecutor.js';
import { actionsToSteps } from '../../src/executor/steps.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, startApp, testConfig } from './harness.js';

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

async function open() {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-h-'));
  return BrowserSession.open(
    testConfig({ outDir: out }),
    new RunArtifacts(out, 'h').forTest('t'),
    silentLogger,
  );
}

describe.skipIf(!hasChromium)('optional app hints', () => {
  it('reads test ids and developer hints, including hidden controls', async () => {
    const s = await open();
    try {
      await s.goto(`${app.base}/hinted`);
      const hints = await readHints(s.page);
      const exit = hints.find((h) => h.selector === '[data-testid="exit"]');
      expect(exit).toMatchObject({ text: 'Exit' });
      expect(hints.find((h) => h.selector === '[data-testid="export"]')?.visible).toBe(true);
      const bar = hints.find((h) => h.reveal === 'hover');
      expect(bar?.hint).toContain('bottom-right');
      expect(bar?.visible).toBe(false); // opacity 0 until hovered
    } finally {
      await s.close();
    }
  });

  it('records the test id instead of the XPath, and replay falls back to the XPath if the id goes away', async () => {
    const s = await open();
    try {
      await s.goto(`${app.base}/hinted`);
      // the click lands on the inner <span>; the test id sits on the button around it
      const xpath = 'xpath=/html/body/button[1]/span';
      const stable = await stableSelector(s.page, xpath, 'click');
      expect(stable).toBe('[data-testid="export"]');
      const { steps } = actionsToSteps(
        [{ type: 'act', playwrightArguments: { selector: xpath, method: 'click', arguments: [] } }],
        1,
        new Map([[xpath, /** @type {string} */ (stable)]]),
      );
      expect(steps[0]).toMatchObject({
        selector: '[data-testid="export"]',
        fallbackSelectors: [xpath],
      });

      // the app drops its test id: replay still finds the element by XPath
      await s.page.evaluate(() =>
        document.querySelector('[data-testid="export"]')?.removeAttribute('data-testid'),
      );
      await runStep(s.page, /** @type {any} */ (steps[0]));
      // aria-busy is set while "exporting": settle waits for it to clear
      expect(await s.settle({ maxMs: 5000, quietMs: 300 })).toBe(true);
      expect(await s.page.locator('#out').textContent()).toBe('Exported');
    } finally {
      await s.close();
    }
  });

  it('agent test-id tools reveal a hover-only control and act on it exactly', async () => {
    const s = await open();
    try {
      await s.goto(`${app.base}/hinted`);
      const tools = testIdTools(s);
      /** @type {any} */
      const list = await /** @type {any} */ (tools.appTestIds).execute(
        {},
        { toolCallId: '1', messages: [] },
      );
      expect(list.elements).toContain('[data-testid="exit"] "Exit" (currently hidden)');
      /** @type {any} */
      const bad = await /** @type {any} */ (tools.useTestId).execute(
        { selector: '#exit', action: 'click' },
        { toolCallId: '2', messages: [] },
      );
      expect(bad.ok).toBe(false);
      const useTestId = /** @type {any} */ (tools.useTestId);
      await useTestId.execute(
        { selector: '[data-testid="exit"]', action: 'hover' },
        { toolCallId: '3', messages: [] },
      );
      expect(await s.page.locator('#bar').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      const r = await useTestId.execute(
        { selector: '[data-testid="exit"]', action: 'click' },
        { toolCallId: '4', messages: [] },
      );
      expect(r.ok).toBe(true);
      expect(await s.page.title()).toBe('Exited');

      // and those calls become replayable steps
      const { steps, recordable } = actionsToSteps(
        [
          { type: 'appTestIds' },
          { type: 'useTestId', selector: '[data-testid="exit"]', action: 'hover', ok: true },
          { type: 'useTestId', selector: '[data-testid="exit"]', action: 'click', ok: true },
          { type: 'useTestId', selector: '#nope', action: 'click', ok: false },
        ],
        1,
      );
      expect(recordable).toBe(true);
      expect(steps.map((x) => x.method)).toEqual(['hover', 'click']);
    } finally {
      await s.close();
    }
  });

  it('waits for a late-rendering app before the start screenshot (no blank captures)', async () => {
    const s = await open();
    try {
      await s.goto(`${app.base}/spa`);
      const base = await s.baseline([]);
      expect(base.text).toContain('rendered late');
    } finally {
      await s.close();
    }
  });
});
