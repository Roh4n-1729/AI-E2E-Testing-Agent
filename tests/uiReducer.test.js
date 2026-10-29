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

  it('keeps only the last 200 log lines and records run errors', () => {
    let s = start;
    for (let i = 0; i < 250; i++) s = reduce(s, { type: 'log', data: { message: `m${i}` } });
    expect(s.logs).toHaveLength(200);
    expect(/** @type {any} */ (s.logs[s.logs.length - 1]).message).toBe('m249');
    s = reduce(s, { type: 'run.error', data: { message: 'boom' } });
    expect(s).toMatchObject({ finished: true, error: 'boom' });
  });
});
