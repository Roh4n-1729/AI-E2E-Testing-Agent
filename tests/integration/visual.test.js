import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { loadConfig } from '../../src/config/config.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { testFingerprint } from '../../src/storage/recordStore.js';
import { silentLogger } from '../../src/util/logger.js';
import { BaselineStore } from '../../src/visual/baselines.js';
import { hasChromium, testConfig } from './harness.js';

// A themed page with a masked live counter. ?gap=4 squeezes the card grid: a purely visual bug.
const page = (
  /** @type {URLSearchParams} */ q,
) => `<!doctype html><html lang="en"><head><title>Visual</title><style>
:root{--bg:#ffffff;--text:#111827;--card:#f3f4f6}.dark{--bg:#0b1020;--text:#e5e7eb;--card:#1f2937}
body{margin:0;padding:24px;background:var(--bg);color:var(--text);font-family:sans-serif}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:${q.get('gap') ?? '16'}px}
.card{background:var(--card);height:120px;border-radius:8px}
</style></head><body><h1>Dashboard</h1>
<p>Updated <span data-aie2e-mask>${Math.random().toString(36).slice(2)}</span></p>
<div class="grid"><div class="card"></div><div class="card"></div><div class="card"></div></div>
</body></html>`;

/** @type {http.Server} */
let srv;
/** @type {string} */
let base;
beforeAll(async () => {
  srv = http.createServer((req, res) =>
    res.end(page(new URL(req.url ?? '/', 'http://x').searchParams)),
  );
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
});
afterAll(() => srv?.close());

const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-visual-'));
const test = /** @type {import('../../src/core/types.js').TestCase} */ ({
  id: 'dash',
  title: 'Dashboard',
  goal: '',
  startUrl: '/',
  expectations: [],
  tags: [],
});

/** One "run": open the page, collect evidence, compare with the baselines. */
async function run(/** @type {string} */ query, /** @type {BaselineStore} */ store) {
  const runId = `r${Math.random().toString(36).slice(2, 7)}`;
  const artifacts = new RunArtifacts(out, runId);
  const s = await BrowserSession.open(
    testConfig({ outDir: out }),
    artifacts.forTest('dash'),
    silentLogger,
  );
  try {
    await s.goto(`${base}/${query}`);
    await s.page.mouse.move(Math.random() * 600, Math.random() * 400); // the harness cursor moves around
    const cfg = loadConfig({}, {});
    const judge = new EvidenceJudge(
      cfg.judge,
      undefined,
      { ...cfg.quality, gate: 'off' },
      {
        store,
        cfg: { ...cfg.visual, gate: 'fail' },
      },
    );
    const { verdict, evidence } = await judge.judge(test, s, {
      mode: 'deterministic',
      steps: [],
      heals: [],
    });
    return { verdict, evidence, runDir: artifacts.runDir, runId };
  } finally {
    await s.close();
  }
}

describe.skipIf(!hasChromium)('visual regression against approved baselines', () => {
  it('the first passing run becomes the baseline; masked areas and the cursor never count as changes', async () => {
    const store = new BaselineStore(path.join(out, 'baselines'), base);
    const first = await run('', store);
    const results = first.evidence.visual?.results ?? [];
    // the final screen, and the final screen in each theme the build ships
    expect(results.map((r) => [r.checkpoint, r.status])).toEqual([
      ['final', 'new'],
      ['theme-light', 'new'],
      ['theme-dark', 'new'],
    ]);
    expect(first.verdict.status).toBe('pass');
    // what TestRunner does after a pass
    for (const r of results)
      await store.save('dash', r.checkpoint, path.join(first.runDir, r.current), {
        runId: first.runId,
        fingerprint: testFingerprint(test),
        how: 'first-pass',
      });

    const again = await run('', store);
    expect(again.evidence.visual?.results?.map((r) => r.status)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
    expect(again.verdict.status).toBe('pass');
  });

  it('a layout change is caught in every theme, with a diff image and the changed area', async () => {
    const store = new BaselineStore(path.join(out, 'baselines'), base);
    const { verdict, evidence, runDir } = await run('?gap=4', store);
    const results = evidence.visual?.results ?? [];
    expect(results.map((r) => r.status)).toEqual(['changed', 'changed', 'changed']);
    const dark = results.find((r) => r.checkpoint === 'theme-dark');
    expect(dark?.diffRatio).toBeGreaterThan(0.001);
    expect(existsSync(path.join(runDir, dark?.diff ?? 'missing'))).toBe(true);
    expect(existsSync(path.join(runDir, dark?.baseline ?? 'missing'))).toBe(true);
    // the change is in the card row, not the masked counter above it
    expect(dark?.box?.y).toBeGreaterThan(100);
    expect(verdict.status).toBe('fail'); // gate: fail
    expect(verdict.reason).toContain('3 of 3 screenshot(s) differ from the approved baseline');
  });
});
