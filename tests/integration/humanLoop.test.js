import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HumanHelp } from '../../src/core/humanHelp.js';
import { TestRunner } from '../../src/core/testRunner.js';
import { RunEvents } from '../../src/events/runEvents.js';
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
 * A fake agent at a step only a person can do: it asks, and reaches the About page only if a person helped (as if
 * they had typed the code that unlocks it).
 * @type {import('../../src/core/ports.js').Executor}
 */
const agent = {
  async execute(test, session, ctx) {
    await session.goto(test.startUrl);
    const baseline = await session.baseline(test.expectations);
    const r = await /** @type {NonNullable<typeof ctx.askHuman>} */ (ctx.askHuman)(
      'Enter the one-time code sent to the phone',
    );
    if (r.answer === 'done') await session.goto(`${app.base}/about`);
    return {
      mode: 'agent',
      steps: [
        {
          index: 0,
          kind: 'act',
          description: 'click',
          selector: 'xpath=/html/body',
          method: 'click',
        },
      ],
      recordable: true,
      heals: [],
      baseline,
      agentClaim: {
        success: r.answer === 'done',
        message: '',
        status: r.answer === 'done' ? 'done' : 'needs-person',
      },
    };
  },
};

/** @param {HumanHelp | undefined} help */
async function run(help) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-help-'));
  const config = testConfig({ outDir: out });
  const artifacts = new RunArtifacts(out, 'h');
  await artifacts.init();
  /** @type {unknown[]} */
  const saved = [];
  let explained = 0;
  const runner = new TestRunner({
    config,
    logger: silentLogger,
    artifacts,
    events: help?.events,
    executor: agent,
    judge: new EvidenceJudge(config.judge),
    recordStore: { load: async () => null, save: async (rec) => void saved.push(rec) },
    explainer: /** @type {any} */ ({
      explain: async () => {
        explained++;
        return undefined;
      },
    }),
    help,
  });
  const result = await runner.run({
    id: 'otp',
    title: 'Sign in with a one-time code',
    goal: 'Sign in and open the about page',
    startUrl: app.base,
    expectations: [{ kind: 'text-visible', text: 'About our team' }],
    tags: [],
  });
  /** @type {import('../../src/core/types.js').RunReport} */
  const report = {
    runId: 'h',
    startedAt: '',
    finishedAt: '',
    targetUrl: app.base,
    summary: {
      total: 1,
      passed: result.verdict.status === 'pass' ? 1 : 0,
      failed: result.verdict.status === 'fail' ? 1 : 0,
      errored: 0,
      healed: 0,
      claimMismatches: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    results: [result],
  };
  return { result, saved, explained, insights: runInsights(report) };
}

describe.skipIf(!hasChromium)('a step only a person can do', () => {
  it('with nobody watching: reported as needing a person, not as an app problem, with no AI reading', async () => {
    const { result, explained, insights } = await run(undefined);
    expect(result.verdict.status).toBe('fail');
    expect(result.help).toEqual([
      expect.objectContaining({
        what: 'Enter the one-time code sent to the phone',
        answer: 'unavailable',
      }),
    ]);
    expect(explained).toBe(0);
    expect(insights.headline).toBe('1 test needs a person');
    expect(insights.kpis.problems).toBe(0);
    expect(insights.tests.otp.outcome).toBe(
      'Needs a person: enter the one-time code sent to the phone',
    );
    expect(insights.findings.map((f) => f.title)).toContain('1 test needs a person');
  });

  it('with a person watching: waits for them, passes on the evidence, says so, and is never recorded', async () => {
    const events = new RunEvents();
    const help = new HumanHelp({ available: true, events });
    events.subscribe((e) => {
      if (e.type === 'test.waiting') setTimeout(() => help.answer(e.data.testId, 'done'), 50);
    });
    const { result, saved, insights } = await run(help);
    expect(result.verdict.status).toBe('pass');
    expect(result.help?.[0]).toMatchObject({ answer: 'done' });
    expect(saved).toEqual([]);
    expect(insights.tests.otp.outcome).toMatch(/\(a person helped\)$/);
    expect(insights.findings.map((f) => f.title)).toContain(
      "“Sign in with a one-time code” passed with a person's help",
    );
    expect(events.history.map((e) => e.type)).toEqual(
      expect.arrayContaining(['test.waiting', 'test.helped', 'test.finished']),
    );
  });
});
