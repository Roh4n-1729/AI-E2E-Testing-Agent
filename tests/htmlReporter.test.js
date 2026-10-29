import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/reporter/htmlReporter.js';

/** @returns {import('../src/core/types.js').TestResult} */
const result = (/** @type {Partial<import('../src/core/types.js').TestResult>} */ over = {}) => ({
  test: {
    id: 't1',
    title: 'Evil <script>alert(1)</script> title',
    goal: 'do "things"',
    startUrl: 'https://a.test/',
    expectations: [],
    tags: [],
  },
  mode: 'healed',
  verdict: {
    status: 'fail',
    reason: 'URL <b>wrong</b>',
    checks: [
      {
        expectation: { kind: 'no-console-errors' },
        passed: false,
        detail: '1 console error(s): <boom>',
      },
    ],
    warnings: ['careful'],
  },
  evidence: {
    finalUrl: 'https://a.test/x',
    title: 'T',
    pageTextExcerpt: '',
    screenshots: [
      { label: 'final', path: 't1/screenshots/001-final.png', url: '', source: 'harness' },
    ],
    console: [{ type: 'error', text: 'boom', ts: '' }],
    networkFailures: [{ url: 'https://a.test/api', method: 'GET', status: 500, ts: '' }],
  },
  agentClaim: { success: true, message: 'All good!' },
  claimMismatch: true,
  heals: [
    {
      testId: 't1',
      stepIndex: 2,
      description: 'click <Buy>',
      oldSelector: '#a',
      newSelector: '#b',
      reason: 'selector missing',
      outcome: 'healed',
    },
  ],
  durationMs: 1234,
  ...over,
});

describe('renderReport', () => {
  const html = renderReport({
    runId: 'r1',
    startedAt: '',
    finishedAt: '2026-10-29T00:00:00Z',
    targetUrl: 'https://a.test/',
    summary: {
      total: 1,
      passed: 0,
      failed: 1,
      errored: 0,
      healed: 1,
      claimMismatches: 1,
      inputTokens: 0,
      outputTokens: 0,
    },
    results: [result()],
  });

  it('escapes untrusted text (titles, reasons, console output)', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Evil &lt;script&gt;');
    expect(html).not.toContain('<boom>');
  });

  it('surfaces heals, claim mismatch, agent claim and screenshots', () => {
    expect(html).toContain('1 heal(s)');
    expect(html).toContain('agent claim ≠ evidence');
    expect(html).toContain('selector missing');
    expect(html).toContain('What the agent claimed (not trusted)');
    expect(html).toContain('src="t1/screenshots/001-final.png"');
    expect(html).toContain('data-group="t1"'); // opens in the viewer, not a new tab
    expect(html).toContain('GET https://a.test/api');
  });
});
