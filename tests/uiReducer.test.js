import { describe, expect, it } from 'vitest';
import { initial, reduce } from '../ui/src/hooks/runReducer.js';

/** @param {any} state @param {Array<[string, any]>} events */
const play = (state, events) =>
  events.reduce((s, [type, data]) => reduce(s, { type, data }), state);
const start = initial;

describe('live-run reducer (the UI is a pure function of the event stream)', () => {
  it('builds tests from the plan and tracks their lifecycle', () => {
    const s = play(start, [
      ['phase', { phase: 'crawl', status: 'running' }],
      ['phase', { phase: 'crawl', status: 'done', detail: '1 page(s)' }],
      [
        'plan.ready',
        {
          tests: [
            { id: 'a', title: 'A', goal: 'g', expectations: [] },
            { id: 'b', title: 'B', goal: '', expectations: [] },
          ],
        },
      ],
      ['test.started', { testId: 'a', title: 'A', goal: 'g' }],
      ['test.step', { testId: 'a', source: 'agent', description: 'click' }],
      ['test.screenshot', { testId: 'a', path: 'a/1.png', source: 'harness' }],
      [
        'test.finished',
        {
          testId: 'a',
          title: 'A',
          status: 'pass',
          mode: 'replay',
          llmUsage: { inputTokens: 1, outputTokens: 2 },
        },
      ],
      ['run.finished', { summary: { total: 2 } }],
    ]);
    expect(s.order).toEqual(['a', 'b']);
    expect(s.phases.crawl).toEqual({ status: 'done', detail: '1 page(s)' });
    expect(s.tests.a).toMatchObject({ status: 'pass' });
    expect(s.tests.a.steps).toHaveLength(1);
    expect(s.tests.a.screenshots).toHaveLength(1);
    expect(s.tests.b.status).toBe('pending');
    expect(s.finished).toBe(true);
  });

  it('copes with events for tests it was never told about (late subscriber)', () => {
    const s = play(start, [
      ['test.step', { testId: 'ghost', description: 'x' }],
      ['test.started', { testId: 'late', title: 'Late', goal: '' }],
    ]);
    expect(s.tests.ghost).toBeUndefined();
    expect(s.tests.late.status).toBe('running');
    expect(s.order).toEqual(['late']);
  });

  it('keeps only the last 1000 log lines and records run errors', () => {
    let s = start;
    for (let i = 0; i < 1050; i++) s = reduce(s, { type: 'log', data: { message: `m${i}` } });
    expect(s.logs).toHaveLength(1000);
    expect(/** @type {any} */ (s.logs[s.logs.length - 1]).message).toBe('m1049');
    s = reduce(s, { type: 'run.error', data: { message: 'boom' } });
    expect(s).toMatchObject({ finished: true, error: 'boom' });
  });

  it('keeps when each test started and finished, for the live timer', () => {
    let s = reduce(start, { type: 'plan.ready', data: { tests: [{ id: 'a', title: 'A' }] } });
    s = reduce(s, { type: 'test.started', data: { testId: 'a', at: '2026-10-31T02:00:00Z' } });
    s = reduce(s, {
      type: 'test.judging',
      data: { testId: 'a', checks: 3, at: '2026-10-31T02:00:30Z' },
    });
    expect(s.tests.a.judging).toEqual({ checks: 3, at: '2026-10-31T02:00:30Z' });
    s = reduce(s, {
      type: 'test.finished',
      data: { testId: 'a', status: 'pass', at: '2026-10-31T02:00:42Z' },
    });
    expect(s.tests.a).toMatchObject({
      status: 'pass',
      startedAt: '2026-10-31T02:00:00Z',
      finishedAt: '2026-10-31T02:00:42Z',
    });
  });

  it('keeps what the crawler found and what the plan review fixed, for the live view', () => {
    const s = play(start, [
      ['phase', { phase: 'login', status: 'done', detail: 'as standard_user' }],
      ['site.ready', { pages: [{ url: 'https://a.test/', title: 'Home' }] }],
      ['plan.review', { found: ['"Shop" is already on the start page'], remaining: [] }],
    ]);
    expect(s.phases.login).toEqual({ status: 'done', detail: 'as standard_user' });
    expect(s.site).toHaveLength(1);
    expect(s.review.found).toHaveLength(1);
  });
});
