import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appKey, compareRuns, digestOf, otherSuite, previousOf } from '../src/reporter/compare.js';
import { RunManager } from '../src/server/runManager.js';

/** @typedef {import('../src/core/types.js').TestResult} TestResult */
/** @typedef {import('../src/core/types.js').RunReport} RunReport */

const URL_ = 'https://shop.test/';
/**
 * @param {string} id @param {'pass' | 'fail' | 'error'} status @param {Partial<TestResult>} [over]
 * @returns {TestResult}
 */
const result = (id, status, over = {}) => ({
  test: { id, title: `Title ${id}`, goal: 'g', startUrl: URL_, expectations: [], tags: [] },
  mode: 'replay',
  verdict: { status, reason: status === 'pass' ? '' : `${id} broke`, checks: [], warnings: [] },
  evidence: {
    finalUrl: URL_,
    title: 'Shop',
    pageTextExcerpt: '',
    screenshots: [],
    console: [],
    networkFailures: [],
  },
  claimMismatch: false,
  heals: [],
  durationMs: 1000,
  ...over,
});
/** @param {string} runId @param {string} at @param {TestResult[]} results @returns {RunReport} */
const report = (runId, at, results) => ({
  runId,
  startedAt: at,
  finishedAt: new Date(Date.parse(at) + 60_000).toISOString(),
  targetUrl: URL_,
  summary: {
    total: results.length,
    passed: results.filter((r) => r.verdict.status === 'pass').length,
    failed: results.filter((r) => r.verdict.status === 'fail').length,
    errored: results.filter((r) => r.verdict.status === 'error').length,
    healed: 0,
    claimMismatches: 0,
    inputTokens: results.reduce((n, r) => n + (r.llmUsage?.inputTokens ?? 0), 0),
    outputTokens: 0,
  },
  results,
});

describe('comparing two runs of the same app', () => {
  const before = digestOf(
    report('r1', '2026-10-31T10:00:00Z', [
      result('login', 'pass', {
        mode: 'agent',
        llmUsage: { inputTokens: 40_000, outputTokens: 0 },
      }),
      result('cart', 'fail'),
      result('search', 'pass'),
      result('export', 'fail'),
      result('old', 'pass'),
    ]),
  );
  const now = digestOf(
    report('r2', '2026-11-01T10:00:00Z', [
      result('login', 'pass'), // now replays for free
      result('cart', 'pass'), // fixed
      result('search', 'fail'), // broke
      result('export', 'fail'), // still failing
      result('new-one', 'pass'),
    ]),
  );

  it('says what got fixed, what broke and what changed, broken first', () => {
    const c = compareRuns(now, before);
    expect(c.trend).toBe('mixed');
    expect(c.sentence).toBe('1 newly failing, 1 fixed, 1 still failing, 1 new, 1 no longer run');
    expect(c.tests.map((t) => [t.id, t.change])).toEqual([
      ['search', 'broke'],
      ['cart', 'fixed'],
      ['export', 'still-failing'],
      ['new-one', 'new'],
      ['old', 'removed'],
      ['login', 'passing'],
    ]);
    expect(c.delta).toMatchObject({ tokens: -40_000, nowReplayed: 1 });
  });

  it('matches a re-planned test by its title when its id changed', () => {
    const renamed = {
      ...now,
      tests: now.tests.map((t) => (t.id === 'cart' ? { ...t, id: 'cart-2' } : t)),
    };
    expect(compareRuns(renamed, before).tests.find((t) => t.id === 'cart-2')?.change).toBe('fixed');
  });

  it('does not call tests a stop cut off newly failing, even in a report from before report.stopped', () => {
    // an older report: no `stopped` flag, but one test was stopped before it started
    const stopped = digestOf(
      report('r3', '2026-11-02T10:00:00Z', [
        result('login', 'pass'),
        result('cart', 'error', {
          verdict: { status: 'error', reason: 'No open page', checks: [], warnings: [] },
        }),
        result('search', 'error', {
          verdict: {
            status: 'error',
            reason: 'Stopped before this test started',
            checks: [],
            warnings: [],
          },
        }),
      ]),
    );
    expect(stopped.stopped).toBe(true);
    expect(stopped.tests.filter((t) => t.cutOff).map((t) => t.id)).toEqual(['cart', 'search']);
    const c = compareRuns(stopped, now);
    expect(c.counts).toMatchObject({ broke: 0, notFinished: 2 });
    expect(c.sentence).toContain('2 not finished (run stopped)');
    // and as the earlier run, its cut-off tests are simply not in it
    expect(compareRuns(now, stopped).tests.find((t) => t.id === 'cart')?.change).toBe('new');
  });

  it('reports no change plainly, and keeps naming what still fails', () => {
    expect(compareRuns(before, before)).toMatchObject({
      trend: 'same',
      sentence: '2 still failing',
    });
    const green = digestOf(report('g', '2026-11-01T00:00:00Z', [result('a', 'pass')]));
    expect(compareRuns(green, green)).toMatchObject({
      trend: 'same',
      sentence: 'No test changed its result',
    });
  });

  it('compares with the latest earlier run of the same app and suite, else of the same app, skipping stopped runs', () => {
    const d = (/** @type {string} */ id, /** @type {string} */ at, extra = {}) => ({
      ...before,
      runId: id,
      startedAt: at,
      ...extra,
    });
    const all = [
      d('a', '2026-10-30T00:00:00Z'),
      d('b', '2026-10-31T00:00:00Z'),
      d('stopped', '2026-10-31T12:00:00Z', { stopped: true }),
      d('suite', '2026-10-31T13:00:00Z', { suite: 'swag-labs' }),
      d('other-app', '2026-10-31T14:00:00Z', { targetUrl: 'https://other.test/' }),
      d('later', '2026-11-02T00:00:00Z'),
    ];
    expect(previousOf(d('now', '2026-11-01T00:00:00Z'), all)?.runId).toBe('b');
    expect(previousOf(d('now', '2026-11-01T00:00:00Z', { suite: 'swag-labs' }), all)?.runId).toBe(
      'suite',
    );
    expect(previousOf(d('first', '2026-10-29T00:00:00Z'), all)).toBeNull();
    // no earlier run of this suite: the latest run of the same app, whatever it ran
    const fresh = d('now', '2026-11-01T00:00:00Z', { suite: 'checkout-only' });
    expect(previousOf(fresh, all)?.runId).toBe('suite');
    expect(otherSuite(fresh, /** @type {any} */ (previousOf(fresh, all)))).toBe(true);
    expect(
      previousOf(d('x', '2026-11-01T00:00:00Z', { targetUrl: 'https://none.test/' }), all),
    ).toBeNull();
    expect(appKey('https://shop.test/#x')).toBe(appKey('https://shop.test'));
  });
});

describe('run history on the server', () => {
  it('keeps a small digest per run, and compares and lists from it', async () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-cmp-'));
    const write = (/** @type {RunReport} */ r) => {
      const dir = path.join(out, 'runs', r.runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r));
    };
    write(
      report('20261031100000-aaaa', '2026-10-31T10:00:00Z', [
        result('a', 'pass'),
        result('b', 'pass'),
      ]),
    );
    write(
      report('20261101100000-bbbb', '2026-11-01T10:00:00Z', [
        result('a', 'pass'),
        result('b', 'fail'),
      ]),
    );
    const runs = new RunManager({ outDir: out });

    const cmp = await runs.compare('20261101100000-bbbb');
    expect(cmp?.previous?.runId).toBe('20261031100000-aaaa');
    expect(cmp?.comparison?.sentence).toBe('1 newly failing');
    expect(cmp?.others.map((o) => o.runId)).toEqual(['20261031100000-aaaa']);
    expect(existsSync(path.join(out, 'runs', '20261101100000-bbbb', 'digest.json'))).toBe(true);

    const history = await runs.history('20261101100000-bbbb');
    expect(history?.map((h) => [h.passed, h.total])).toEqual([
      [2, 2],
      [1, 2],
    ]);
    const list = await runs.list();
    expect(list.map((r) => r.summary?.passed)).toEqual([1, 2]);
    expect(await runs.compare('../etc')).toBeNull();
  });
});
