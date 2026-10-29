import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { loadConfig } from '../../src/config/config.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { mockLlm } from '../helpers.js';
import { hasChromium, startApp, testConfig } from './harness.js';

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

async function open() {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-j-'));
  return BrowserSession.open(
    testConfig({ outDir: out }),
    new RunArtifacts(out, 'j').forTest('t'),
    silentLogger,
  );
}

/** @param {import('../../src/core/types.js').Expectation[]} expectations */
const testCase = (expectations) => ({
  id: 't',
  title: 'T',
  goal: 'add to cart',
  startUrl: `${app.base}/shop`,
  expectations,
  tags: [],
});

/** @param {any} options @returns {number} */
const imagesSent = (options) =>
  options.prompt
    .flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : []))
    .filter((/** @type {any} */ c) => c.type === 'file' || c.type === 'image').length;

describe.skipIf(!hasChromium)('judge', () => {
  it('visual checks see the start, the run and the end, not one screenshot', async () => {
    const s = await open();
    try {
      await s.goto(`${app.base}/shop`);
      await s.screenshot('start');
      const baseline = await s.baseline([]);
      await s.page.click('#add');
      await s.screenshot('agent', 'harness');
      const spy = { calls: /** @type {any[]} */ ([]) };
      const judge = new EvidenceJudge(
        loadConfig({}, {}).judge,
        mockLlm({ answer: true, reasoning: 'The cart message appeared' }, spy),
      );
      const { verdict } = await judge.judge(
        testCase([{ kind: 'visual', question: 'Was the item added to the cart?' }]),
        s,
        {
          mode: 'agent',
          steps: [],
          heals: [],
          baseline,
          agentClaim: { success: true, message: '' },
        },
      );
      expect(verdict.status).toBe('pass');
      // start, the mid-run frame, and the page now (the identical final capture is de-duplicated)
      expect(imagesSent(spy.calls[0])).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(spy.calls[0].prompt)).toContain('first = before the test acted');
    } finally {
      await s.close();
    }
  });

  it('an agent that says it failed is not overruled by screenshot-reading alone', async () => {
    const s = await open();
    try {
      await s.goto(`${app.base}/shop`);
      const baseline = await s.baseline([]);
      const judge = new EvidenceJudge(
        loadConfig({}, {}).judge,
        mockLlm({ answer: true, reasoning: 'Looks fine' }),
      );
      const claim = { success: false, message: 'I could not find the next-slide control' };
      const soft = await judge.judge(
        testCase([{ kind: 'visual', question: 'Is a cart shown?' }]),
        s,
        { mode: 'agent', steps: [], heals: [], baseline, agentClaim: claim },
      );
      expect(soft.verdict.status).toBe('fail');
      expect(soft.verdict.reason).toContain('agent reported it could not complete');

      // ...but hard evidence still wins: the agent can be wrong about its own failure
      await s.page.click('#add');
      const hard = await judge.judge(
        testCase([{ kind: 'text-visible', text: 'Added to cart' }]),
        s,
        { mode: 'agent', steps: [], heals: [], baseline, agentClaim: claim },
      );
      expect(hard.verdict.status).toBe('pass');
    } finally {
      await s.close();
    }
  });
});
