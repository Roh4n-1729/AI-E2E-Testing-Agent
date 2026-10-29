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

// A themed page whose only theme bug lives in a dialog: a final-state-only audit misses it once the
// dialog closes again. The page is tall so the scroll position can be checked after an audit.
const STATES_PAGE = `<!doctype html><html lang="en"><head><title>States</title><style>
:root{--bg:#ffffff;--text:#111827;--primary:#0f766e;--on-primary:#ffffff;--radius:6px}
.dark{--bg:#0b1020;--text:#e5e7eb;--primary:#2dd4bf;--on-primary:#04201c}
body{background:var(--bg);color:var(--text);font-family:sans-serif;margin:0;padding:16px;min-height:3000px}
button{background:var(--primary);color:var(--on-primary);border:0;border-radius:var(--radius);padding:6px 12px}
dialog{background:#ffffff;color:#111827;border:0;padding:24px;width:420px;height:220px}
</style></head><body><main><h1>Settings</h1>
<button id="open" onclick="document.getElementById('d').showModal()">Edit profile</button></main>
<dialog id="d"><h2>Profile</h2><button id="close" onclick="document.getElementById('d').close()">Close</button></dialog>
</body></html>`;

describe.skipIf(!hasChromium)('theme conformance on every screen a test reaches', () => {
  /** @type {import('node:http').Server} */
  let srv;
  /** @type {string} */
  let base;
  afterAll(() => srv?.close());

  async function open(/** @type {any} */ themeStates) {
    if (!srv) {
      const http = await import('node:http');
      srv = http.createServer((_q, r) => r.end(STATES_PAGE));
      await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
      base = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
    }
    const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-states-'));
    const s = await BrowserSession.open(
      testConfig({ outDir: out }),
      new RunArtifacts(out, 'r').forTest(`t${Math.random().toString(36).slice(2, 6)}`),
      silentLogger,
      { themeStates },
    );
    await s.goto(`${base}/settings`);
    return s;
  }

  it('audits the dialog the test opened, although the final screen no longer shows it', async () => {
    const { ThemeStates: TS } = await import('../../src/theme/states.js');
    const s = await open(new TS());
    try {
      const start = await s.auditState('start', { step: 0 });
      // the inventory saw the button, for the cross-page consistency check
      const inv = start?.audit.themes[0]?.inventory ?? [];
      expect(inv.find((e) => e.kind === 'button')?.style).toMatchObject({ background: '#0f766e' });
      await s.page.click('#open');
      const inDialog = await s.auditState('after step 1', { step: 1 });
      expect(inDialog?.audit.themes.find((t) => t.id === 'dark')?.leaks.length).toBeGreaterThan(0);
      await s.page.click('#close'); // back to the start screen: the final audit alone would be clean
      const evidence = await s.collectEvidence();
      expect(evidence.themeStates?.map((st) => st.label)).toEqual(['start', 'after step 1']);
      expect(evidence.theme?.themes.flatMap((t) => t.leaks)).toEqual([]); // final = start: clean
      const judge = new EvidenceJudge(loadConfig({}, {}).judge, undefined, {
        ...loadConfig({}, {}).quality,
        gate: 'fail',
      });
      const { verdict } = await judge.judge(
        {
          id: 't',
          title: 'T',
          goal: '',
          startUrl: base,
          expectations: [
            { kind: 'theme-conformance', minScore: 0.9, allowLeaks: false, allowHardCoded: false },
          ],
          tags: [],
        },
        s,
        { mode: 'deterministic', steps: [], heals: [] },
      );
      expect(verdict.status).toBe('fail');
      expect(verdict.reason).toContain('[after step 1]');
      expect(verdict.reason).toContain('#d'); // the dialog, with the rule that hard-codes its white
    } finally {
      await s.close();
    }
  });

  it('reuses a screen another test already audited, and leaves the scroll position alone', async () => {
    const { ThemeStates: TS } = await import('../../src/theme/states.js');
    const shared = new TS();
    const a = await open(shared);
    const b = await open(shared);
    try {
      await a.page.evaluate(() => scrollTo(0, 900));
      const first = await a.auditState('start', { step: 0 });
      expect(first?.reusedFrom).toBeUndefined();
      expect(await a.page.evaluate(() => scrollY)).toBe(900); // scroll-safe in-between audit
      const second = await b.auditState('start', { step: 0 });
      expect(second?.reusedFrom).toEqual({ testId: first?.testId, label: 'start' });
      expect(shared.audited).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
