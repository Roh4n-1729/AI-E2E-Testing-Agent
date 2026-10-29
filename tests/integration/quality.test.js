import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { loadConfig } from '../../src/config/config.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, startApp, testConfig } from './harness.js';

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

/** @param {{ id: string, method: string, xpath: string }} a */
const click = (a) => ({
  selector: `xpath=${a.xpath}`,
  method: a.method,
  arguments: [],
  description: a.id,
});

async function openLab() {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-q-'));
  const artifacts = new RunArtifacts(out, 'q');
  const s = await BrowserSession.open(
    testConfig({ outDir: out }),
    artifacts.forTest('t'),
    silentLogger,
  );
  await s.goto(`${app.base}/lab`);
  return s;
}

/**
 * @param {BrowserSession} s
 * @param {import('../../src/core/types.js').Expectation[]} expectations
 * @param {Partial<import('../../src/config/config.js').ConfigInput['quality']>} [quality]
 */
async function judgeWith(s, expectations, quality) {
  const cfg = loadConfig({ quality: { gate: 'fail', ...quality } }, {});
  const judge = new EvidenceJudge(cfg.judge, undefined, cfg.quality);
  const test = {
    id: 't',
    title: 'T',
    goal: 'do it',
    startUrl: `${app.base}/lab`,
    expectations,
    tags: [],
  };
  return judge.judge(test, s, { mode: 'agent', steps: [], heals: [], baseline: base });
}
/** @type {import('../../src/core/types.js').Baseline} */
let base;

describe.skipIf(!hasChromium)('quality evidence (what a QA engineer would check)', () => {
  it('captures API calls, downloads, transient toasts, vitals and accessibility; the judge uses them', async () => {
    const s = await openLab();
    try {
      base = await s.baseline([]);
      await s.stagehand.act(click({ id: 'gen', method: 'click', xpath: '//button[@id="gen"]' }));
      await s.stagehand.act(click({ id: 'exp', method: 'click', xpath: '//button[@id="exp"]' }));
      await s.page.waitForTimeout(700); // the toast is long gone by now
      expect(await s.page.getByText('Deck downloaded').count()).toBe(0);

      const { verdict, evidence } = await judgeWith(s, [
        { kind: 'api-call', urlPattern: '/api/generate', method: 'POST', maxDurationMs: 5000 },
        { kind: 'download', filenamePattern: '.pptx' },
        { kind: 'text-appeared', text: 'Deck downloaded' },
        { kind: 'text-visible', text: 'Generated 3' },
      ]);

      const call = evidence.requests?.find((r) => r.url.endsWith('/api/generate'));
      expect(call).toMatchObject({ method: 'POST', status: 200, api: true });
      expect(call?.durationMs).toBeGreaterThan(50);
      expect(evidence.requestStats?.api).toBeGreaterThanOrEqual(1);
      expect(evidence.downloads?.[0]).toMatchObject({ filename: 'deck.pptx', bytes: 5 });
      expect(evidence.seenText?.map((t) => t.text)).toContain('Deck downloaded');
      expect((evidence.vitals ?? []).flatMap((v) => v.metrics.map((m) => m.name))).toContain(
        'TTFB',
      );
      expect(evidence.a11y?.violations.map((v) => v.id)).toContain('image-alt');

      const byKind = Object.fromEntries(verdict.checks.map((c) => [c.expectation.kind, c]));
      expect(byKind['api-call']?.passed).toBe(true);
      expect(byKind['download']?.passed).toBe(true);
      expect(byKind['text-appeared']?.passed).toBe(true);
      // gate = fail: the missing alt text (critical) fails the test even though the goal checks pass
      expect(byKind['no-a11y-violations']?.passed).toBe(false);
      expect(verdict.status).toBe('fail');
      expect(verdict.reason).toContain('image-alt');
    } finally {
      await s.close();
    }
  });

  it('the quality gate "warn" reports problems without failing the test', async () => {
    const s = await openLab();
    try {
      base = await s.baseline([]);
      await s.stagehand.act(click({ id: 'gen', method: 'click', xpath: '//button[@id="gen"]' }));
      const { verdict } = await judgeWith(s, [{ kind: 'text-visible', text: 'Generated 3' }], {
        gate: 'warn',
      });
      expect(verdict.status).toBe('pass');
      const a11y = verdict.checks.find((c) => c.expectation.kind === 'no-a11y-violations');
      expect(a11y).toMatchObject({ passed: false, advisory: true });
      expect(verdict.warnings.join(' ')).toContain('image-alt');
    } finally {
      await s.close();
    }
  });

  it('rejects what did not happen: no download, no such API call, impossible budget', async () => {
    const s = await openLab();
    try {
      base = await s.baseline([]);
      const { verdict } = await judgeWith(
        s,
        [
          { kind: 'download' },
          { kind: 'api-call', urlPattern: '/api/never' },
          { kind: 'text-appeared', text: 'Totally absent' },
          { kind: 'web-vitals', ttfbMs: 0.001 },
        ],
        { gate: 'off' },
      );
      expect(verdict.checks.map((c) => c.passed)).toEqual([false, false, false, false]);
      expect(verdict.status).toBe('fail');
    } finally {
      await s.close();
    }
  });

  it('an API call made while the page loaded does not count as proof the agent did anything', async () => {
    const s = await openLab();
    try {
      await s.page.evaluate(() => fetch('/api/generate', { method: 'POST' }));
      await s.page.waitForTimeout(300);
      base = await s.baseline([]); // the call above happened BEFORE the agent acts
      const { verdict } = await judgeWith(
        s,
        [{ kind: 'api-call', urlPattern: '/api/generate', method: 'POST' }],
        { gate: 'off' },
      );
      expect(verdict.checks[0]).toMatchObject({ passed: true, vacuous: true });
      expect(verdict.status).toBe('fail');
      expect(verdict.reason).toContain('Inconclusive');
    } finally {
      await s.close();
    }
  });

  it('captures a server-sent file download too', async () => {
    const s = await openLab();
    try {
      base = await s.baseline([]);
      await s.stagehand.act(click({ id: 'csv', method: 'click', xpath: '//a[@id="csv"]' }));
      await s.page.waitForTimeout(500);
      const { verdict, evidence } = await judgeWith(
        s,
        [{ kind: 'download', filenamePattern: 'csv' }],
        {
          gate: 'off',
        },
      );
      expect(evidence.downloads?.[0]?.filename).toBe('report.csv');
      expect(verdict.checks[0]?.passed).toBe(true);
    } finally {
      await s.close();
    }
  });
});
