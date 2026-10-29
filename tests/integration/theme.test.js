import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createShop } from '../../examples/buggy-shop/server.js';
import { BrowserSession } from '../../src/browser/session.js';
import { loadConfig } from '../../src/config/config.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { auditThemes } from '../../src/theme/audit.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, testConfig } from './harness.js';

/** @type {import('node:http').Server[]} */
const servers = [];
afterAll(() => servers.forEach((s) => s.close()));

/** @param {string} bugs */
async function openShop(bugs) {
  const srv = createShop({ bugs });
  servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-theme-'));
  const s = await BrowserSession.open(
    testConfig({ outDir: out }),
    new RunArtifacts(out, 'r').forTest('t'),
    silentLogger,
  );
  await s.goto(`http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/`);
  return { s, dir: path.join(out, 'theme') };
}

describe.skipIf(!hasChromium)('theme conformance (real browser)', () => {
  it('a fully tokenised app scores 100% in light and dark, and the page is left as it was', async () => {
    const { s, dir } = await openShop('none');
    try {
      const a = await auditThemes(s.page, { dir, rel: (x) => x });
      expect(a.themes.map((t) => [t.id, t.score])).toEqual([
        ['light', 1],
        ['dark', 1],
      ]);
      expect(a.themes.flatMap((t) => [...t.findings, ...t.leaks])).toEqual([]);
      expect(a.themes.every((t) => t.contrastIssues === 0)).toBe(true);
      expect(await s.page.evaluate(() => document.documentElement.className)).toBe('');
      expect(await s.page.locator('[data-aie2e-probe]').count()).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('finds hard-coded values with the CSS rule that set them, and dark-mode leaks', async () => {
    const { s, dir } = await openShop('hardcoded-color,dark-leak,off-scale-radius');
    try {
      const a = await auditThemes(s.page, { dir, rel: (x) => x });
      const [light, dark] = a.themes;
      const color = light?.findings.find((f) => f.value === '#2f6fe4');
      expect(color).toMatchObject({
        kind: 'hard-coded',
        category: 'background',
        nearest: { token: '--color-primary' },
      });
      expect(color?.declaration?.selector).toBe('.newsletter button');
      expect(color?.declaration?.source).toMatch(/inline <style>.*:\d+/);
      expect(color?.crop).toBeTruthy();
      expect(light?.findings.find((f) => f.category === 'radius')).toMatchObject({
        value: '7px',
        count: 3,
      });
      // the white card is fine in light mode and a leak in dark mode
      expect(light?.leaks).toEqual([]);
      expect(dark?.leaks[0]).toMatchObject({
        value: '#ffffff',
        selector: expect.stringContaining('newsletter'),
      });
      expect(dark?.contrastIssues).toBeGreaterThan(0);

      // the judge turns it into a check (gate = fail makes it count)
      const cfg = loadConfig({ quality: { gate: 'fail' } }, {});
      const { verdict } = await new EvidenceJudge(cfg.judge, undefined, cfg.quality).judge(
        { id: 't', title: 'T', goal: '', startUrl: 'http://x/', expectations: [], tags: [] },
        s,
        { mode: 'deterministic', steps: [], heals: [] },
      );
      const check = verdict.checks.find((c) => c.expectation.kind === 'theme-conformance');
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain('surface(s) ignore the theme');
      expect(verdict.status).toBe('fail');
    } finally {
      await s.close();
    }
  });
});
