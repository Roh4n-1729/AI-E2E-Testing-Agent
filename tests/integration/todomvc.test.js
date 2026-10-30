import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTodoMvc } from '../../examples/todomvc/server.js';
import { startRun } from '../../src/app/startRun.js';
import { hasChromium } from './harness.js';

/** @type {import('node:http').Server[]} */
const servers = [];
afterAll(() => servers.forEach((s) => s.close()));

/** @param {string} bugs */
async function todomvc(bugs) {
  const s = createTodoMvc({ bugs });
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
  return `http://127.0.0.1:${/** @type {any} */ (s.address()).port}/`;
}

/** @param {string} url */
const runSuite = (url) =>
  startRun({
    url,
    suite: 'examples/todomvc/suite.json',
    heal: false,
    quality: 'off',
    concurrency: 3,
    outDir: mkdtempSync(path.join(os.tmpdir(), 'aie2e-todo-')),
  });

describe.skipIf(!hasChromium)('TodoMVC, a third-party app (committed suite, no LLM)', () => {
  it('is green on the real app and catches two regressions, each in the right test', async () => {
    process.env.AIE2E_LOG_LEVEL = 'silent';
    const clean = await runSuite(await todomvc('none'));
    expect(clean.report.summary).toMatchObject({ total: 6, passed: 6 });
    expect(clean.report.results.every((r) => r.mode !== 'agent')).toBe(true);

    const buggy = await runSuite(await todomvc('clear-broken,edit-lost'));
    const failed = buggy.report.results.filter((r) => r.verdict.status !== 'pass');
    expect(failed.map((r) => r.test.id).sort()).toEqual([
      'clear-completed-todos',
      'edit-a-todo-by-double-clicking-it',
    ]);
  }, 180_000);
});
