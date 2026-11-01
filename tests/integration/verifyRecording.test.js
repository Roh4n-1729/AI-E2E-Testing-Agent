import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestRunner } from '../../src/core/testRunner.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { FileRecordStore } from '../../src/storage/recordStore.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, startApp, testConfig } from './harness.js';

/** @typedef {import('../../src/core/types.js').RecordedStep} RecordedStep */

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

/**
 * A fake agent that reaches the About page (so the judge passes it) and reports `steps` as what it did: the
 * recording that would be saved.
 * @param {(base: string) => RecordedStep[]} steps @param {boolean} [verify]
 */
async function run(steps, verify = true) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-verify-'));
  const config = testConfig({ outDir: out, verifyRecordings: verify });
  const artifacts = new RunArtifacts(out, 'v');
  await artifacts.init();
  const store = new FileRecordStore(path.join(out, 'recordings'));
  /** @type {import('../../src/core/ports.js').Executor} */
  const agent = {
    async execute(test, session) {
      await session.goto(test.startUrl);
      const baseline = await session.baseline(test.expectations);
      await session.goto(`${app.base}/about`);
      return {
        mode: 'agent',
        agentClaim: { success: true, message: 'done' },
        steps: steps(app.base),
        recordable: true,
        heals: [],
        baseline,
      };
    },
  };
  const runner = new TestRunner({
    config,
    logger: silentLogger,
    artifacts,
    executor: agent,
    judge: new EvidenceJudge(config.judge),
    verifyJudge: new EvidenceJudge(config.judge),
    recordStore: store,
  });
  const result = await runner.run({
    id: 'about',
    title: 'Open About',
    goal: 'Open the About page',
    startUrl: app.base,
    expectations: [{ kind: 'text-visible', text: 'About our team' }],
    tags: [],
  });
  return { result, saved: await store.load('about') };
}

/** @param {string} selector @returns {(base: string) => RecordedStep[]} */
const clickAbout = (selector) => (base) => [
  { index: 0, kind: 'navigate', description: 'Open the app', url: base },
  { index: 1, kind: 'act', description: 'Click About us', selector, method: 'click' },
];

describe.skipIf(!hasChromium)('a new recording is replayed once before it is kept', () => {
  it('keeps a recording that replays on its own', async () => {
    const { result, saved } = await run(clickAbout('xpath=//a[text()="About us"]'));
    expect(result.verdict.status).toBe('pass');
    expect(result.recording).toEqual({ saved: true, verified: true });
    expect(saved?.steps).toHaveLength(2);
  });

  it('drops one that does not, and says why; the test itself still passed', async () => {
    const { result, saved } = await run(clickAbout('#not-on-the-page'));
    expect(result.verdict.status).toBe('pass');
    expect(result.recording?.saved).toBe(false);
    expect(result.recording?.reason).toContain('Click About us');
    expect(saved).toBeNull();
  });

  it('saves without the check when it is switched off', async () => {
    const { result, saved } = await run(clickAbout('#not-on-the-page'), false);
    expect(result.recording).toEqual({ saved: true, verified: false });
    expect(saved).not.toBeNull();
  });
  it("upgrades an absolute XPath to the control's role and name while replaying, keeping the XPath", async () => {
    const xpath = 'xpath=/html[1]/body[1]/nav[1]/a[1]';
    const { result, saved } = await run(clickAbout(xpath));
    expect(result.recording).toEqual({ saved: true, verified: true });
    expect(saved?.steps[1]).toMatchObject({
      selector: 'internal:role=link[name="About us"s]',
      fallbackSelectors: [xpath],
    });
  });
});
