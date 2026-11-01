import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestRunner } from '../../src/core/testRunner.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { runInsights } from '../../src/reporter/insights.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, startApp, testConfig } from './harness.js';

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

/**
 * A fake agent that finds the About page only when told how (the hint), like an agent that never thought of
 * the chat box until the reading pointed at it.
 * @type {import('../../src/core/ports.js').Executor}
 */
const agent = {
  async execute(test, session, ctx) {
    await session.goto(test.startUrl);
    const baseline = await session.baseline(test.expectations);
    if (ctx.hint?.includes('About us link')) await session.goto(`${app.base}/about`);
    return {
      mode: 'agent',
      steps: [],
      heals: [],
      baseline,
      agentClaim: { success: !!ctx.hint, message: '' },
    };
  },
};

/** @param {import('../../src/judge/failureExplainer.js').FailureExplainer['explain']} explain @param {boolean} [retry] */
async function run(explain, retry = true) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-retry-'));
  const config = testConfig({ outDir: out, retryTestProblems: retry });
  const artifacts = new RunArtifacts(out, 'r');
  await artifacts.init();
  const runner = new TestRunner({
    config,
    logger: silentLogger,
    artifacts,
    executor: agent,
    fallbackExecutor: agent,
    judge: new EvidenceJudge(config.judge),
    explainer: /** @type {any} */ ({ explain }),
  });
  return runner.run({
    id: 'about',
    title: 'Read about the team',
    goal: 'Find out who runs the company',
    startUrl: app.base,
    expectations: [{ kind: 'text-visible', text: 'About our team' }],
    tags: [],
  });
}

/** @param {'test-problem' | 'app-bug'} category */
const reading = (category) => async () => ({
  cause: 'The agent stayed on the home page.',
  category,
  confidence: /** @type {const} */ ('high'),
  evidence: [],
  suggestion: 'Use the About us link in the top navigation.',
  model: 'm',
});

describe.skipIf(!hasChromium)('a second try when the AI blames the test', () => {
  it('tries once more with the reading as a hint, and says it passed on the second try', async () => {
    const r = await run(reading('test-problem'));
    expect(r.verdict.status).toBe('pass');
    expect(r.retry).toMatchObject({ passed: true, other: { status: 'fail' } });
    expect(r.retry?.hint).toContain('About us link');
    const i = runInsights({
      runId: 'r',
      startedAt: '',
      finishedAt: '',
      targetUrl: app.base,
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        errored: 0,
        healed: 0,
        claimMismatches: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      results: [r],
    });
    expect(i.findings.map((f) => f.title)).toContain(
      '“Read about the team” passed on a second try',
    );
  });

  it('does not retry an app bug, or when switched off', async () => {
    const bug = await run(reading('app-bug'));
    expect(bug.verdict.status).toBe('fail');
    expect(bug.retry).toBeUndefined();
    const off = await run(reading('test-problem'), false);
    expect(off.verdict.status).toBe('fail');
    expect(off.retry).toBeUndefined();
  });
});
