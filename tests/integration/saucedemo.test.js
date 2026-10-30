import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSauceDemo } from '../../examples/saucedemo/server.js';
import { startRun } from '../../src/app/startRun.js';
import { hasChromium } from './harness.js';

/** @type {import('node:http').Server} */
let server;
let url = '';
const saved = { u: process.env.AIE2E_USERNAME, p: process.env.AIE2E_PASSWORD };
beforeAll(async () => {
  server = createSauceDemo();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/`;
});
afterAll(() => {
  server.close();
  process.env.AIE2E_USERNAME = saved.u;
  process.env.AIE2E_PASSWORD = saved.p;
});

// one output folder for both runs: the standard user's first run approves the screenshot baselines
const outDir = mkdtempSync(path.join(os.tmpdir(), 'aie2e-sauce-'));
/** @param {string} user */
const runAs = (user) => {
  process.env.AIE2E_USERNAME = user;
  process.env.AIE2E_PASSWORD = 'secret_sauce'; // the public demo password printed on the login page
  return startRun({
    url,
    suite: 'examples/saucedemo/suite.json',
    heal: false,
    quality: 'off',
    concurrency: 3,
    outDir,
  });
};

describe.skipIf(!hasChromium)('Sauce Demo: a real app whose bugs depend on who logs in', () => {
  it('is green for the standard user and fails for the problem user, never for login reasons', async () => {
    process.env.AIE2E_LOG_LEVEL = 'silent';
    const good = await runAs('standard_user');
    expect(good.report.summary).toMatchObject({ total: 6, passed: 6 });
    expect(good.report.auth?.username).toBe('standard_user');
    // the declared third-party noise (fonts, error reporter) never fails a test, but nothing else is ignored
    expect(JSON.stringify(good.report)).not.toContain('secret_sauce');

    const bad = await runAs('problem_user');
    const failed = bad.report.results
      .filter((r) => r.verdict.status === 'fail')
      .map((r) => r.test.id);
    expect(failed).toEqual(
      expect.arrayContaining([
        'every-product-shows-its-own-photo',
        'sort-products-by-price-low-to-high',
        'place-an-order',
      ]),
    );
    expect(bad.report.summary.errored).toBe(0);
  }, 240_000);

  it('a locked-out user stops the run at login with the reason, before any test runs', async () => {
    await expect(runAs('locked_out_user')).rejects.toThrow(/inventory\.html/);
  }, 60_000);
});
