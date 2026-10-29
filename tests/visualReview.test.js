import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server/app.js';
import { BaselineStore } from '../src/visual/baselines.js';

const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-review-'));
const runId = '20261030010101-0001';
const capture = 'checkout/visual/001-final.png';

// a finished run whose "final" screenshot differs from the baseline
const runDir = path.join(out, 'runs', runId);
mkdirSync(path.join(runDir, 'checkout', 'visual'), { recursive: true });
writeFileSync(path.join(runDir, capture), PNG.sync.write(new PNG({ width: 4, height: 4 })));
writeFileSync(
  path.join(runDir, 'report.json'),
  JSON.stringify({
    runId,
    startedAt: '2026-10-30T01:01:01Z',
    finishedAt: '2026-10-30T01:02:01Z',
    targetUrl: 'http://localhost:4310/',
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      healed: 0,
      claimMismatches: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    results: [
      {
        test: {
          id: 'checkout',
          title: 'Checkout',
          goal: 'Buy',
          startUrl: '/',
          expectations: [],
          tags: [],
        },
        mode: 'replay',
        verdict: { status: 'pass', reason: '', checks: [], warnings: [] },
        evidence: {
          finalUrl: '',
          title: '',
          pageTextExcerpt: '',
          screenshots: [],
          console: [],
          networkFailures: [],
          visual: {
            captures: [],
            results: [{ checkpoint: 'final', label: 'final', status: 'changed', current: capture }],
          },
        },
        claimMismatch: false,
        heals: [],
        durationMs: 1,
      },
    ],
  }),
);

const { app } = await createServer({ outDir: out, uiDir: path.join(out, 'no-ui') });
afterAll(() => app.close());

describe('visual review API', () => {
  it('approve copies the screenshot into the baselines and records the decision', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/visual`,
      payload: { testId: 'checkout', checkpoint: 'final', action: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const store = new BaselineStore(path.join(out, 'baselines'), 'http://localhost:4310/');
    const base = await store.get('checkout', 'final');
    expect(base?.meta).toMatchObject({ runId, how: 'approved' });
    expect(existsSync(base?.path ?? 'missing')).toBe(true);

    const run = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(run.json().review['checkout|final'].action).toBe('approve');
  });

  it('reject records the decision and keeps the baseline; unknown screenshots are refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/visual`,
      payload: { testId: 'checkout', checkpoint: 'final', action: 'reject' },
    });
    expect(res.json().review['checkout|final'].action).toBe('reject');
    const missing = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/visual`,
      payload: { testId: 'checkout', checkpoint: 'theme-dark', action: 'approve' },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/runs/..%2F..%2Fetc/visual`,
      payload: { testId: 'checkout', checkpoint: 'final', action: 'approve' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
