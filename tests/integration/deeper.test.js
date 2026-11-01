import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestRunner } from '../../src/core/testRunner.js';
import { probePage } from '../../src/crawler/bfsCrawler.js';
import { AgentExecutor } from '../../src/executor/agentExecutor.js';
import { CachingExecutor } from '../../src/executor/cachingExecutor.js';
import { ReplayExecutor } from '../../src/executor/replayExecutor.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { FileRecordStore, testFingerprint } from '../../src/storage/recordStore.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, startApp, testConfig } from './harness.js';

/** @typedef {import('../../src/core/types.js').TestCase} TestCase */
/** @typedef {import('../../src/core/types.js').RecordedStep} RecordedStep */

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

/** The steps an earlier test recorded: open the lab, press Generate ("Generated 3" appears). */
const generate = () =>
  /** @type {RecordedStep[]} */ ([
    { index: 0, kind: 'navigate', description: 'Open the lab', url: `${app.base}/lab` },
    { index: 1, kind: 'act', description: 'Click Generate', selector: '#gen', method: 'click' },
  ]);

/**
 * Run one test through the real runner and judge. With `recording`, the caching executor replays it (no AI);
 * otherwise the agent executor runs, which needs no model for a test without a goal.
 * @param {TestCase} test @param {RecordedStep[]} [recording]
 */
async function run(test, recording) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-deep-'));
  const config = testConfig({ outDir: out });
  const artifacts = new RunArtifacts(out, 'deep');
  await artifacts.init();
  const store = new FileRecordStore(path.join(out, 'recordings'));
  if (recording)
    await store.save({
      schemaVersion: 1,
      testId: test.id,
      fingerprint: testFingerprint(test),
      recordedAt: 'now',
      steps: recording,
    });
  const agent = new AgentExecutor(config);
  const runner = new TestRunner({
    config,
    logger: silentLogger,
    artifacts,
    executor: recording
      ? new CachingExecutor({ agent, replay: new ReplayExecutor(), store, heal: false })
      : agent,
    judge: new EvidenceJudge(config.judge),
  });
  return runner.run(test);
}

/** @param {Partial<TestCase>} over @returns {TestCase} */
const test = (over) => ({
  id: 'deep',
  title: 'Deeper',
  goal: 'Generate a result',
  startUrl: `${app.base}/lab`,
  expectations: [{ kind: 'text-visible', text: 'Generated 3' }],
  tags: [],
  ...over,
});

describe.skipIf(!hasChromium)('starting on a deeper screen', () => {
  it('judges from the screen the prefix reaches: what is already there proves nothing', async () => {
    // Without a prefix, pressing Generate is the test's own action, so "Generated 3" proves it worked.
    const plain = await run(test({}), generate());
    expect(plain.verdict.status).toBe('pass');

    // The same steps as a prefix only REACH the starting screen: "Generated 3" is there before the test acts.
    const deep = await run(
      test({ prefix: generate(), startsFrom: { testId: 'gen', title: 'Generate', url: '' } }),
      generate(),
    );
    expect(deep.mode).toBe('replay');
    expect(deep.verdict.status).toBe('fail');
    expect(deep.verdict.reason).toContain('Inconclusive');
    expect(deep.verdict.checks[0]?.vacuous).toBe(true);
  });

  it('replays the prefix with Playwright before the test, and records what the final screen offers', async () => {
    const r = await run(
      test({
        goal: '',
        expectations: [{ kind: 'no-console-errors' }],
        prefix: generate(),
        startsFrom: { testId: 'gen', title: 'Generate', url: `${app.base}/lab` },
      }),
    );
    expect(r.verdict.status).toBe('pass');
    expect(r.evidence.pageTextExcerpt).toContain('Generated 3');
    expect(r.trace?.some((t) => t.source === 'replay' && t.description === 'Click Generate')).toBe(
      true,
    );
    expect(r.trace?.some((t) => t.description.includes('where "Generate" ended'))).toBe(true);
    expect(r.evidence.screen?.buttons).toEqual(expect.arrayContaining(['Generate', 'Export']));
    expect(r.evidence.screen?.apiCalls).toContain('POST /api/generate');
  });

  it('fails plainly when the steps to the starting screen no longer work', async () => {
    const broken = generate();
    broken[1] = { ...broken[1], selector: '#gone', description: 'Click Generate (gone)' };
    const r = await run(
      test({
        goal: '',
        expectations: [{ kind: 'no-console-errors' }],
        prefix: broken,
        startsFrom: { testId: 'gen', title: 'Generate', url: '' },
      }),
    );
    expect(r.verdict.status).toBe('fail');
    expect(r.verdict.reason).toContain('Could not reach the screen this test starts on');
  });

  it('reads what a fresh browser shows at an address (for starting round 2 there)', async () => {
    const snap = await probePage(testConfig(), `${app.base}/lab`);
    expect(snap?.url).toBe(`${app.base}/lab`);
    expect(snap?.buttons).toEqual(expect.arrayContaining(['Generate', 'Export']));
    expect(await probePage(testConfig(), 'http://127.0.0.1:1/nothing-here')).toBeNull();
  });
});
