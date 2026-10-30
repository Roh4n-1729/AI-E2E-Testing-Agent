import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createShop } from '../../examples/buggy-shop/server.js';
import { startRun } from '../../src/app/startRun.js';
import { hasChromium } from './harness.js';

/** @type {import('node:http').Server[]} */
const servers = [];
afterAll(() => servers.forEach((s) => s.close()));

/** @param {string} bugs */
async function shop(bugs) {
  const s = createShop({ bugs });
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
  return `http://127.0.0.1:${/** @type {any} */ (s.address()).port}/`;
}

/** @param {string} url */
const runSuite = (url) =>
  startRun({
    url,
    suite: 'examples/buggy-shop/suite.json',
    heal: false,
    quality: 'off',
    concurrency: 4,
    outDir: mkdtempSync(path.join(os.tmpdir(), 'aie2e-shop-')),
  });

describe.skipIf(!hasChromium)('seeded-bug shop (committed suite, no LLM)', () => {
  it('is green on the clean app and catches a wrong cart total', async () => {
    process.env.AIE2E_LOG_LEVEL = 'silent';
    const clean = await runSuite(await shop('none'));
    expect(clean.report.summary).toMatchObject({ total: 7, passed: 7 });
    expect(clean.report.results.every((r) => r.mode !== 'agent')).toBe(true);

    const buggy = await runSuite(await shop('wrong-total'));
    const failed = buggy.report.results.filter((r) => r.verdict.status !== 'pass');
    expect(failed.map((r) => r.test.id)).toEqual(['cart-total-follows-the-quantity']);
    expect(failed[0]?.verdict.reason).toContain('₹598');
  }, 120_000);
});

describe.skipIf(!hasChromium)('baselines are only approved by runs that may approve them', () => {
  it('a run with frozen baselines (a seeded-bug run in the evaluation) saves none; a normal run does', async () => {
    process.env.AIE2E_LOG_LEVEL = 'silent';
    const { existsSync, readdirSync } = await import('node:fs');
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'aie2e-freeze-'));
    const url = await shop('dead-button');
    const opts = {
      url,
      suite: 'examples/buggy-shop/suite.json',
      heal: false,
      quality: /** @type {const} */ ('off'),
      concurrency: 4,
      outDir,
    };
    const frozen = await startRun({ ...opts, freezeBaselines: true });
    expect(frozen.report.summary.passed).toBeGreaterThan(0);
    expect(existsSync(path.join(outDir, 'baselines'))).toBe(false);

    await startRun(opts);
    expect(readdirSync(path.join(outDir, 'baselines'), { recursive: true }).length).toBeGreaterThan(
      0,
    );
  }, 120_000);
});
