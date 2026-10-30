import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShop } from '../../examples/buggy-shop/server.js';
import { BrowserSession } from '../../src/browser/session.js';
import { loadConfig } from '../../src/config/config.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { captureReference } from '../../src/theme/reference.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, testConfig } from './harness.js';

// A "design system" site of another brand: violet primary, different names for the tokens.
const BRAND = `<!doctype html><html lang="en"><head><title>Brand</title><style>
:root{--brand-bg:#ffffff;--brand-surface:#faf5ff;--brand-ink:#1e1b4b;--brand-primary:#7c3aed;--brand-on-primary:#ffffff;--brand-radius:6px}
body{background:var(--brand-bg);color:var(--brand-ink)}</style></head><body><h1>Brand tokens</h1></body></html>`;
// A product with no CSS variables at all: it can still be checked against a reference.
const PLAIN = `<!doctype html><html lang="en"><head><title>Plain</title><style>
body{background:#ffffff;color:#1e1b4b;font-family:sans-serif}button{background:#7c3aed;color:#ffffff;border:0;border-radius:6px;padding:8px 12px}
.promo{background:#ff6600;color:#ffffff;padding:16px}</style></head><body><h1>Plain product</h1><button>Buy</button><div class="promo">Sale</div></body></html>`;

/** @type {import('node:http').Server[]} */
const servers = [];
/** @type {Record<string, string>} */
const url = {};
const listen = (/** @type {import('node:http').Server} */ srv) =>
  new Promise((r) => {
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () =>
      r(`http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/`),
    );
  });
beforeAll(async () => {
  url.shop = /** @type {string} */ (await listen(createShop({ bugs: 'none' })));
  url.brand = /** @type {string} */ (await listen(http.createServer((_q, r) => r.end(BRAND))));
  url.plain = /** @type {string} */ (await listen(http.createServer((_q, r) => r.end(PLAIN))));
});
afterAll(() => servers.forEach((s) => s.close()));

const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-ref-'));
const cfg = testConfig({ outDir: out });

/** Audit `target` against the reference product at `ref`. */
async function auditAgainst(/** @type {string} */ target, /** @type {string} */ ref) {
  const reference = await captureReference({ url: ref, cfg, logger: silentLogger });
  const s = await BrowserSession.open(
    cfg,
    new RunArtifacts(out, `r${Math.random()}`.slice(0, 8)).forTest('t'),
    silentLogger,
    {
      themeReference: reference,
    },
  );
  try {
    await s.goto(target);
    const state = await s.auditState('final', { final: true });
    const judge = new EvidenceJudge(loadConfig({}, {}).judge, undefined, {
      ...loadConfig({}, {}).quality,
      gate: 'fail',
    });
    const { verdict } = await judge.judge(
      { id: 't', title: 'T', goal: '', startUrl: target, expectations: [], tags: [] },
      s,
      { mode: 'deterministic', steps: [], heals: [] },
    );
    return { audit: state?.audit, verdict, reference };
  } finally {
    await s.close();
  }
}

describe.skipIf(!hasChromium)('theme conformance against another product (--theme-from)', () => {
  it('a product checked against its own themes matches 100% in light and dark', async () => {
    const { audit, verdict, reference } = await auditAgainst(url.shop, url.shop);
    expect(reference.themes.map((t) => t.id)).toEqual(['light', 'dark']);
    expect(audit?.reference).toBe(url.shop);
    expect(audit?.themes.map((t) => [t.id, t.score])).toEqual([
      ['light', 1],
      ['dark', 1],
    ]);
    expect(
      verdict.checks.find((c) => c.expectation.kind === 'theme-conformance')?.detail,
    ).toContain(`against ${url.shop}`);
  });

  it('another brand: the shop blue is off-reference, with the brand token it should have used', async () => {
    const { audit, verdict } = await auditAgainst(url.shop, url.brand);
    const light = audit?.themes.find((t) => t.id === 'light');
    expect(light?.score).toBeLessThan(0.9);
    const blue = light?.findings.find((f) => f.value === '#2563eb');
    expect(blue).toMatchObject({ kind: 'off-reference', nearest: { token: '--brand-primary' } });
    expect(verdict.status).toBe('fail');
    expect(verdict.reason).toContain(`Theme conformance against ${url.brand}`);
  });

  it('a product without any CSS variables is still checked against the reference', async () => {
    const { audit } = await auditAgainst(url.plain, url.brand);
    expect(audit?.themes.map((t) => t.id)).toEqual(['default']);
    const findings = audit?.themes[0]?.findings ?? [];
    // the button already uses the brand violet; the orange promo does not
    expect(findings.some((f) => f.value === '#7c3aed')).toBe(false);
    expect(findings.find((f) => f.value === '#ff6600')?.kind).toBe('off-reference');
  });
});
