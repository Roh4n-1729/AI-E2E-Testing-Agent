import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserHost } from '../../src/browser/host.js';
import { BrowserSession } from '../../src/browser/session.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, testConfig } from './harness.js';

// A page that remembers a visit in every kind of storage, makes one API call, and has a file input.
const PAGE = `<!doctype html><title>Shared</title>
<p id="seen"></p><input id="f" type="file" accept=".csv"><p id="out">No file</p>
<script>
  const was = [localStorage.getItem('v'), sessionStorage.getItem('v'), document.cookie.includes('v=1') ? 'cookie' : null];
  seen.textContent = was.filter(Boolean).join(',') || 'fresh';
  localStorage.setItem('v', 'local'); sessionStorage.setItem('v', 'session'); document.cookie = 'v=1; path=/';
  fetch('/api/ping');
  f.onchange = () => { out.textContent = 'Got ' + f.files[0].name; };
</script>`;

/** @type {http.Server} */
let server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/ping') return void res.end('{}');
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});
afterAll(() => server?.close());

describe.skipIf(!hasChromium)('one browser window for a whole run', () => {
  it('reuses the window, but each test starts clean and hears only its own events', async () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-host-'));
    const cfg = testConfig({ outDir: out });
    const host = new BrowserHost(cfg, silentLogger);
    const artifacts = new RunArtifacts(out, 'h');
    try {
      const open = (/** @type {string} */ id) =>
        BrowserSession.open(cfg, artifacts.forTest(id), silentLogger, { host });

      const a = await open('a');
      /** @type {string[]} */
      const uploadsA = [];
      a.onUpload = (u) => uploadsA.push(u.file ?? '');
      await a.goto(base);
      expect(await a.page.locator('#seen').textContent()).toBe('fresh');
      await a.goto(base); // the same test sees its own storage
      expect(await a.page.locator('#seen').textContent()).toBe('local,session,cookie');
      await a.page.context().newPage(); // a tab the agent opened
      const browser = a.browser;
      await a.close();

      const b = await open('b');
      /** @type {string[]} */
      const uploadsB = [];
      b.onUpload = (u) => uploadsB.push(u.file ?? '');
      expect(b.browser).toBe(browser); // the same window
      expect(b.context.pages()).toHaveLength(1); // the extra tab is gone
      await b.goto(base);
      expect(await b.page.locator('#seen').textContent()).toBe('fresh'); // storage and cookies cleared
      await b.page.locator('#f').click();
      await b.page.getByText('Got sample.csv').waitFor({ timeout: 5000 });
      await b.page.waitForTimeout(200);
      expect(uploadsB).toEqual(['sample.csv']); // answered once, by this test only
      expect(uploadsA).toEqual([]);
      const ev = await b.collectEvidence();
      expect(ev.requests?.filter((r) => r.url.endsWith('/api/ping'))).toHaveLength(1); // not the earlier test's
      await b.close();
      expect(host.uses).toBe(2);
    } finally {
      await host.close();
    }
  });
});
