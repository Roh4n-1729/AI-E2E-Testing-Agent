import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FailureExplainer, explainPrompt } from '../src/judge/failureExplainer.js';
import { silentLogger } from '../src/util/logger.js';
import { mockLlm } from './helpers.js';

/** @typedef {import('../src/core/types.js').TestResult} TestResult */

const runDir = mkdtempSync(path.join(os.tmpdir(), 'aie2e-explain-'));
mkdirSync(path.join(runDir, 't'), { recursive: true });
for (const f of ['start.png', '2.png', 'final.png']) writeFileSync(path.join(runDir, 't', f), f);

/** @param {Partial<TestResult>} [over] @returns {TestResult} */
const failed = (over = {}) => ({
  test: {
    id: 'order',
    title: 'Place an order',
    goal: 'Check out and finish the order',
    startUrl: 'https://shop.test/',
    expectations: [],
    tags: [],
  },
  mode: 'replay',
  verdict: {
    status: 'fail',
    reason: 'Step 3 "Click Finish" failed: TimeoutError: locator.click: Timeout 8000ms exceeded.',
    warnings: [],
    checks: [
      {
        expectation: {
          kind: 'text-visible',
          text: 'Thank you',
          label: 'The thank-you message appears',
        },
        passed: false,
        detail: 'not visible',
      },
    ],
  },
  evidence: {
    finalUrl: 'https://shop.test/checkout',
    title: 'Shop',
    pageTextExcerpt: 'Checkout: Your Information\nError: Last Name is required',
    screenshots: [
      { label: 'start', path: 't/start.png', url: 'https://shop.test/', source: 'harness' },
      { label: 'final', path: 't/final.png', url: 'https://shop.test/checkout', source: 'harness' },
    ],
    console: [],
    networkFailures: [],
  },
  trace: [
    {
      index: 0,
      source: 'harness',
      tool: 'goto',
      description: 'Open',
      ok: true,
      url: 'https://shop.test/',
      screenshot: 't/start.png',
      ts: '',
    },
    {
      index: 1,
      source: 'replay',
      tool: 'fill',
      description: 'Type the last name',
      ok: true,
      url: 'https://shop.test/checkout',
      screenshot: 't/2.png',
      ts: '',
    },
    {
      index: 2,
      source: 'replay',
      tool: 'click',
      description: 'Click Finish',
      ok: false,
      url: 'https://shop.test/checkout',
      ts: '',
    },
  ],
  claimMismatch: false,
  heals: [],
  durationMs: 1,
  ...over,
});

const answer = {
  cause: 'The last name never reached its field, so checkout stops with “Last Name is required”.',
  category: 'app-bug',
  confidence: 'high',
  evidence: ['The page says “Error: Last Name is required”', 'a', 'b', 'c'],
  suggestion: 'Check the last-name input.',
};

describe('failure explainer (advisory, after the verdict)', () => {
  it('reads the failed checks, the steps, the page text and three screenshots', async () => {
    const spy = { calls: /** @type {any[]} */ ([]) };
    const ex = new FailureExplainer(mockLlm(answer, spy), runDir, silentLogger, 'anthropic/judge');
    const e = await ex.explain(failed());
    expect(e).toMatchObject({ category: 'app-bug', confidence: 'high', model: 'anthropic/judge' });
    expect(e?.evidence).toHaveLength(3);
    const sent = JSON.stringify(spy.calls[0]);
    expect(sent).toContain('The thank-you message appears');
    expect(sent).toContain('Click Finish  <- FAILED');
    expect(sent).toContain('Error: Last Name is required');
    expect(sent).toContain('never say the test passed');
    // start, the screenshot before the failed step, and the end state
    const images = spy.calls[0].prompt[1].content.filter(
      (/** @type {any} */ c) => c.type === 'file' || c.type === 'image',
    );
    expect(images).toHaveLength(3);
  });

  it('is never asked about a passing test', async () => {
    const spy = { calls: /** @type {any[]} */ ([]) };
    const ex = new FailureExplainer(mockLlm(answer, spy), runDir, silentLogger, 'm');
    const pass = failed({ verdict: { status: 'pass', reason: '', checks: [], warnings: [] } });
    expect(await ex.explain(pass)).toBeUndefined();
    expect(spy.calls).toHaveLength(0);
  });

  it('a model that fails or answers nonsense costs the run nothing', async () => {
    const ex = new FailureExplainer(mockLlm({ nope: true }), runDir, silentLogger, 'm');
    expect(await ex.explain(failed())).toBeUndefined();
  });

  it('says when the agent claimed something, marked as not trusted', () => {
    const p = explainPrompt(failed({ agentClaim: { success: true, message: 'Order placed!' } }));
    expect(p).toContain('The browser agent reported (not trusted): Order placed!');
  });
});
