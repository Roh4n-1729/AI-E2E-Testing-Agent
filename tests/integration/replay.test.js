import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestRunner } from '../../src/core/testRunner.js';
import { CachingExecutor } from '../../src/executor/cachingExecutor.js';
import { ReplayExecutor } from '../../src/executor/replayExecutor.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { testFingerprint } from '../../src/storage/recordStore.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, startApp, testConfig } from './harness.js';

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

const GOOD = 'xpath=//button[@id="add"]';

/** In-memory RecordStore. */
class MemStore {
  /** @type {Map<string, import('../../src/core/types.js').Recording>} */
  map = new Map();
  async load(/** @type {string} */ id) {
    return this.map.get(id) ?? null;
  }
  async save(/** @type {import('../../src/core/types.js').Recording} */ r) {
    this.map.set(r.testId, r);
  }
}

/**
 * Stands in for the Stagehand agent: really drives the page with Playwright (so the judge sees real
 * evidence) and reports the replayable steps the real agent would. `click` selects what it presses.
 */
class FakeAgent {
  /** @type {Array<import('../../src/core/types.js').ResumeContext | null>} */
  calls = [];
  /** @param {string | null} click  CSS selector the fake agent clicks, or null to do nothing */
  constructor(click = '#add') {
    this.click = click;
  }
  /**
   * @param {import('../../src/core/types.js').TestCase} test
   * @param {import('../../src/browser/session.js').BrowserSession} session
   * @param {import('../../src/core/ports.js').TestContext} _ctx
   * @param {import('../../src/core/types.js').ResumeContext} [resume]
   * @returns {Promise<import('../../src/core/types.js').ExecutionOutcome>}
   */
  async execute(test, session, _ctx, resume) {
    this.calls.push(resume ?? null);
    /** @type {import('../../src/core/types.js').RecordedStep[]} */
    const prior = resume
      ? resume.completed
      : [{ index: 0, kind: 'navigate', description: 'Open', url: test.startUrl }];
    let baseline = resume?.baseline;
    if (!resume) {
      await session.goto(test.startUrl);
      baseline = await session.baseline(test.expectations);
    }
    if (this.click) await session.page.locator(this.click).click();
    return {
      mode: 'agent',
      agentClaim: { success: true, message: 'done' },
      steps: [
        ...prior,
        {
          index: prior.length,
          kind: 'act',
          description: 'Click Add to cart',
          selector: GOOD,
          method: 'click',
          arguments: [],
        },
      ],
      recordable: true,
      heals: [],
      baseline,
      llmUsage: { inputTokens: 10, outputTokens: 1 },
    };
  }
}

/** @param {string} [text] */
const makeTest = (text = 'Added to cart') =>
  /** @type {import('../../src/core/types.js').TestCase} */ ({
    id: 'shop',
    title: 'Add to cart',
    goal: 'Add the item to the cart',
    startUrl: `${app.base}/shop`,
    expectations: [{ kind: 'text-visible', text }, { kind: 'no-console-errors' }],
    tags: [],
  });

/** @param {FakeAgent} agent @param {MemStore} store */
async function runWith(agent, store, test = makeTest()) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-rp-'));
  const config = testConfig({ outDir: out });
  const artifacts = new RunArtifacts(out, 'rp');
  await artifacts.init();
  const runner = new TestRunner({
    config,
    logger: silentLogger,
    artifacts,
    executor: new CachingExecutor({
      agent: /** @type {any} */ (agent),
      replay: new ReplayExecutor(),
      store,
    }),
    recordStore: store,
    fallbackExecutor: /** @type {any} */ (agent),
    judge: new EvidenceJudge(config.judge),
  });
  return runner.run(test);
}

describe.skipIf(!hasChromium)('record, replay and self-healing', () => {
  it('records a passing agent run, then replays it with zero agent calls', async () => {
    const store = new MemStore();
    const agent = new FakeAgent();

    const first = await runWith(agent, store);
    expect(first.verdict.status, first.verdict.reason).toBe('pass');
    expect(first.mode).toBe('agent');
    expect(store.map.get('shop')?.steps.map((s) => s.kind)).toEqual(['navigate', 'act']);

    const second = await runWith(agent, store);
    expect(second.verdict.status, second.verdict.reason).toBe('pass');
    expect(second.mode).toBe('replay');
    expect(second.llmUsage).toBeUndefined();
    expect(agent.calls).toHaveLength(1); // only the recording run used the agent
  });

  it('does not record a run the judge failed', async () => {
    const store = new MemStore();
    const r = await runWith(new FakeAgent(null), store); // agent does nothing
    expect(r.verdict.status).toBe('fail');
    expect(store.map.size).toBe(0);
  });

  it('heals a broken step: the agent continues from the current page, the heal is logged, the cache is updated', async () => {
    const store = new MemStore();
    const agent = new FakeAgent();
    await runWith(agent, store);
    const rec = /** @type {import('../../src/core/types.js').Recording} */ (store.map.get('shop'));
    store.map.set('shop', {
      ...rec,
      steps: rec.steps.map((s) =>
        s.kind === 'act' ? { ...s, selector: 'xpath=//button[@id="gone"]' } : s,
      ),
    });

    const r = await runWith(agent, store);
    expect(r.verdict.status, r.verdict.reason).toBe('pass');
    expect(r.mode).toBe('healed');
    expect(r.heals).toHaveLength(1);
    expect(r.heals[0]).toMatchObject({
      outcome: 'healed',
      oldSelector: 'xpath=//button[@id="gone"]',
      newSelector: GOOD,
    });
    expect(agent.calls.at(-1)?.completed).toHaveLength(1); // resumed after the navigate step
    expect(store.map.get('shop')?.steps.find((s) => s.kind === 'act')?.selector).toBe(GOOD);
  });

  it('does not hide a real regression: replay finishes, judge fails, agent also cannot reach the goal', async () => {
    const store = new MemStore();
    const test = makeTest('Purchased'); // never appears
    store.map.set('shop', {
      schemaVersion: 1,
      testId: 'shop',
      fingerprint: testFingerprint(test),
      recordedAt: '',
      steps: [
        { index: 0, kind: 'navigate', description: 'Open', url: test.startUrl },
        {
          index: 1,
          kind: 'act',
          description: 'Click',
          selector: GOOD,
          method: 'click',
          arguments: [],
        },
      ],
    });
    const before = JSON.stringify(store.map.get('shop'));
    const r = await runWith(new FakeAgent(), store, test);
    expect(r.verdict.status).toBe('fail');
    expect(r.heals.at(-1)?.outcome).toBe('failed');
    expect(JSON.stringify(store.map.get('shop'))).toBe(before); // recording left untouched
  });

  it('re-verifies a stale recording with the agent and logs it as a heal when the agent reaches the goal', async () => {
    const store = new MemStore();
    const test = makeTest();
    store.map.set('shop', {
      schemaVersion: 1,
      testId: 'shop',
      fingerprint: testFingerprint(test),
      recordedAt: '',
      steps: [
        { index: 0, kind: 'navigate', description: 'Open', url: test.startUrl },
        // replays fine but clicks the wrong button, so "Added to cart" never appears
        {
          index: 1,
          kind: 'act',
          description: 'Click',
          selector: 'xpath=//button[@id="noop"]',
          method: 'click',
          arguments: [],
        },
      ],
    });
    const r = await runWith(new FakeAgent(), store, test);
    expect(r.verdict.status, r.verdict.reason).toBe('pass');
    expect(r.mode).toBe('healed');
    expect(r.heals.at(-1)).toMatchObject({ outcome: 'healed' });
    expect(store.map.get('shop')?.steps.at(-1)?.selector).toBe(GOOD);
  });

  it('ignores a recording whose test changed (fingerprint mismatch)', async () => {
    const store = new MemStore();
    const agent = new FakeAgent();
    await runWith(agent, store);
    const changed = { ...makeTest(), goal: 'A different goal' };
    const r = await runWith(agent, store, changed);
    expect(r.mode).toBe('agent');
    expect(agent.calls).toHaveLength(2);
  });
});
