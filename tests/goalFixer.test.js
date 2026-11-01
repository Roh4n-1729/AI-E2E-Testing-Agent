import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canFixGoal, proposeGoal } from '../src/judge/goalFixer.js';
import { createServer } from '../src/server/app.js';
import { mockLlm } from './helpers.js';

/** @typedef {import('../src/core/types.js').TestResult} TestResult */

/** @param {Partial<TestResult>} [over] @returns {TestResult} */
const failed = (over = {}) => ({
  test: {
    id: 'improve',
    title: 'Improve a slide with AI',
    goal: 'Use the control that rewrites the slide',
    startUrl: 'https://app.test/',
    expectations: [
      { kind: 'visual', question: 'Did the slide text change?' },
      { kind: 'no-console-errors' },
    ],
    tags: [],
  },
  mode: 'agent',
  verdict: { status: 'fail', reason: 'Visual: no', checks: [], warnings: [] },
  evidence: {
    finalUrl: 'https://app.test/deck/1',
    title: 'Deck',
    pageTextExcerpt: 'Slide 2 The Time Management Challenge',
    screenshots: [],
    console: [],
    networkFailures: [],
    screen: {
      buttons: ['Insert', 'Export'],
      inputs: ['Ask AI'],
      links: [],
      forms: 0,
      testIds: [],
      hints: [],
      apiCalls: [],
    },
  },
  explanation: {
    cause: 'The agent never used the AI chat panel.',
    category: 'test-problem',
    confidence: 'high',
    evidence: [],
    suggestion: 'Ask for the rewrite in the chat box.',
    model: 'm',
  },
  claimMismatch: false,
  heals: [],
  durationMs: 1,
  ...over,
});

describe('a better goal for a test the AI blamed on itself', () => {
  it('is offered only for test problems and second-try passes, never for app bugs', () => {
    expect(canFixGoal(failed())).toBe(true);
    expect(
      canFixGoal(
        failed({
          explanation: /** @type {any} */ ({ ...failed().explanation, category: 'app-bug' }),
        }),
      ),
    ).toBe(false);
    const second = failed({
      verdict: { status: 'pass', reason: '', checks: [], warnings: [] },
      explanation: undefined,
      retry: { hint: 'use the chat', passed: true, other: { status: 'fail', reason: 'no' } },
    });
    expect(canFixGoal(second)).toBe(true);
    expect(canFixGoal(failed({ test: { ...failed().test, goal: '' } }))).toBe(false);
  });

  it('asks for the goal only, with the checks given as fixed', async () => {
    const spy = { calls: /** @type {any[]} */ ([]) };
    const fix = await proposeGoal(
      mockLlm(
        {
          goal: 'Select slide 2, type "Rewrite this slide" in the Ask AI box and send it.',
          changed: 'Uses the chat box.',
        },
        spy,
      ),
      failed(),
    );
    expect(fix.goal).toContain('Ask AI box');
    const prompt = JSON.stringify(spy.calls[0]);
    expect(prompt).toContain('Checks (fixed, you cannot change them): Did the slide text change?');
    expect(prompt).toContain('Text boxes on the last screen: Ask AI');
    expect(prompt).toContain('never used the AI chat panel');
  });
});

describe('the goal-fix endpoint', () => {
  it('refuses tests it cannot fix, and unknown tests', async () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-fix-'));
    const runId = '20261101100000-abcd';
    const dir = path.join(out, 'runs', runId);
    mkdirSync(dir, { recursive: true });
    const bug = failed({
      explanation: /** @type {any} */ ({ ...failed().explanation, category: 'app-bug' }),
    });
    writeFileSync(
      path.join(dir, 'report.json'),
      JSON.stringify({
        runId,
        startedAt: '',
        finishedAt: '',
        targetUrl: 'https://app.test/',
        summary: {},
        results: [bug],
      }),
    );
    const { app } = await createServer({ outDir: out });
    const no = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tests/improve/goal-fix`,
    });
    expect(no.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tests/nope/goal-fix`,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
