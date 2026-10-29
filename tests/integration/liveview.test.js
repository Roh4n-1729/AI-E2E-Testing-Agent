import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { hoverAtTool } from '../../src/executor/agentExecutor.js';
import { actionsToSteps } from '../../src/executor/steps.js';
import { runStep } from '../../src/executor/replayExecutor.js';
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
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-lv-'));
  return BrowserSession.open(
    testConfig({ outDir: out }),
    new RunArtifacts(out, 'lv').forTest('t'),
    silentLogger,
  );
}

describe.skipIf(!hasChromium)('live view', () => {
  it('streams smooth video frames only while someone is watching', async () => {
    const s = await open();
    try {
      await s.goto(`${app.base}/anim`);
      let watching = false;
      /** @type {Buffer[]} */
      const frames = [];
      const stop = s.startLiveView(
        (jpeg) => frames.push(jpeg),
        () => watching,
      );

      await s.page.waitForTimeout(1200);
      expect(frames.length).toBe(0); // nobody watching: nothing captured

      watching = true;
      await s.page.waitForTimeout(2000);
      stop();
      // a 4 fps screenshot poll would give ~8 frames in 2 s; the screencast follows the animation
      expect(frames.length).toBeGreaterThan(20);
      expect(frames[0]?.subarray(0, 2).toString('hex')).toBe('ffd8'); // JPEG
    } finally {
      await s.close();
    }
  });

  it('shows an idle page to a viewer who joins late', async () => {
    const s = await open();
    try {
      await s.goto(`${app.base}/about`);
      await s.page.waitForTimeout(500);
      let watching = false;
      /** @type {Buffer[]} */
      const frames = [];
      const stop = s.startLiveView(
        (jpeg) => frames.push(jpeg),
        () => watching,
      );
      await s.page.waitForTimeout(600);
      watching = true;
      await s.page.waitForTimeout(1800);
      stop();
      expect(frames.length).toBeGreaterThanOrEqual(1);
    } finally {
      await s.close();
    }
  });
});

describe.skipIf(!hasChromium)('hover-revealed controls', () => {
  it('the agent tool moves the real pointer and Stagehand accepts it as a custom tool', async () => {
    process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used';
    const s = await open();
    try {
      await s.goto(`${app.base}/present`);
      const hover = hoverAtTool(s);
      // @ts-expect-error execute is defined for this tool
      await hover.execute(
        { xPercent: 90, yPercent: 90, why: 'toolbar' },
        { toolCallId: '1', messages: [] },
      );
      expect(await s.page.locator('#exit').isVisible()).toBe(true);
      const agent = s.stagehand.agent({
        mode: 'dom',
        model: { modelName: 'anthropic/claude-haiku-4-5' },
        tools: { hoverAt: hover },
      });
      expect(typeof agent.execute).toBe('function');
    } finally {
      await s.close();
    }
  });

  it('a hoverAt tool call becomes a replayable mouse step that reveals the control', async () => {
    const { steps, recordable } = actionsToSteps(
      [
        { type: 'hoverAt', xPercent: 92.04, yPercent: 95, why: 'show the toolbar' },
        {
          type: 'act',
          playwrightArguments: {
            selector: '//button[@id="exit"]',
            method: 'click',
            arguments: [],
            description: 'Click Exit',
          },
        },
      ],
      0,
    );
    expect(recordable).toBe(true);
    expect(steps[0]).toMatchObject({ kind: 'mouse', arguments: ['92', '95'] });

    const s = await open();
    try {
      await s.goto(`${app.base}/present`);
      expect(await s.page.locator('#exit').isVisible()).toBe(false);
      for (const step of steps) await runStep(s.page, step);
      expect(await s.page.title()).toBe('Exited');
    } finally {
      await s.close();
    }
  });
});
