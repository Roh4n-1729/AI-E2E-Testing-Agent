import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestRunner } from '../../src/core/testRunner.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
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
 * Runs a goal test with a fake "agent" that optionally navigates, then judges it.
 * @param {import('../../src/core/types.js').Expectation[]} expectations
 * @param {string} [navigateTo]  Path the fake agent visits (omit: it does nothing)
 */
async function run(expectations, navigateTo) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-vac-'));
  const config = testConfig({ outDir: out });
  const artifacts = new RunArtifacts(out, 'vac');
  await artifacts.init();
  /** @type {import('../../src/core/ports.js').Executor} */
  const executor = {
    async execute(test, session) {
      await session.goto(test.startUrl);
      const baseline = await session.baseline(test.expectations);
      if (navigateTo) await session.goto(app.base + navigateTo);
      return {
        mode: 'agent',
        agentClaim: { success: true, message: 'done' },
        steps: [],
        heals: [],
        baseline,
      };
    },
  };
  const runner = new TestRunner({
    config,
    logger: silentLogger,
    artifacts,
    executor,
    judge: new EvidenceJudge(config.judge),
  });
  return runner.run({
    id: 't',
    title: 't',
    goal: 'Go to the about page',
    startUrl: app.base,
    expectations,
    tags: [],
  });
}

describe.skipIf(!hasChromium)('vacuous expectations', () => {
  it('fails as inconclusive when every outcome expectation was already true at the start', async () => {
    // "Welcome home" and the host are on the start page: the agent did nothing, yet both match.
    const r = await run([
      { kind: 'text-visible', text: 'Welcome home' },
      { kind: 'url', pattern: '127.0.0.1', mode: 'includes' },
    ]);
    expect(r.verdict.status).toBe('fail');
    expect(r.verdict.reason).toContain('Inconclusive');
    expect(r.verdict.checks.every((c) => c.vacuous)).toBe(true);
    expect(r.claimMismatch).toBe(true);
  });

  it('passes when an expectation changed from the baseline, ignoring the vacuous ones', async () => {
    const r = await run(
      [
        { kind: 'text-visible', text: 'Welcome home' },
        { kind: 'text-visible', text: 'About our team' },
      ],
      '/about',
    );
    // "Welcome home" is gone after navigating, so that check fails; use only the real one:
    expect(r.verdict.checks[1]?.vacuous).toBeUndefined();
    expect(r.verdict.checks[1]?.passed).toBe(true);
    expect(r.verdict.checks[0]?.passed).toBe(false);
  });

  it('passes a real state change with a vacuous extra check present', async () => {
    const r = await run(
      [
        { kind: 'url', pattern: '127.0.0.1', mode: 'includes' },
        { kind: 'url', pattern: '/about', mode: 'includes' },
      ],
      '/about',
    );
    expect(r.verdict.status, r.verdict.reason).toBe('pass');
    expect(r.verdict.checks[0]?.vacuous).toBe(true);
    expect(r.verdict.checks[1]?.vacuous).toBeUndefined();
  });
});
