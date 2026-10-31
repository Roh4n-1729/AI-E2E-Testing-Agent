import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, testConfig } from './harness.js';

// A Next.js-style crash: the server renders an error screen, the page logs a minified React error,
// and a request fails. The agent cannot see any of this on its own.
const CRASH = `<!doctype html><html lang="en"><head><title>Community</title></head><body>
<h2>Application error: a server-side exception has occurred (Digest: 3277243575)</h2>
<script>console.error('Minified React error #425; visit https://reactjs.org/docs/error-decoder.html?invariant=425');
fetch('/api/feed')</script></body></html>`;

/** @type {import('node:http').Server} */
let server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/feed') return void res.writeHead(500).end('boom');
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/community' ? CRASH : '<!doctype html><title>Home</title><h1>Home</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
afterAll(() => server.close());

describe.skipIf(!hasChromium)("the agent's read-only harnessStatus tool", () => {
  it('tells the agent about an error screen, explained console errors and failed requests', async () => {
    const cfg = testConfig({ outDir: mkdtempSync(path.join(os.tmpdir(), 'aie2e-hs-')) });
    const s = await BrowserSession.open(
      cfg,
      new RunArtifacts(cfg.outDir, 'r1').forTest('t'),
      silentLogger,
    );
    try {
      await s.goto(`${base}/`);
      expect((await s.harnessStatus()).errorScreen).toBeNull();

      await s.goto(`${base}/community`);
      await s.page.waitForTimeout(300);
      const st = await s.harnessStatus();
      expect(st.url).toContain('/community');
      expect(st.errorScreen).toContain('Application error');
      expect(st.consoleErrors).toBeGreaterThan(0);
      expect(st.recentConsoleErrors.join(' ')).toContain('hydration mismatch');
      expect(st.recentFailedRequests.join(' ')).toContain('500');
    } finally {
      await s.close();
    }
  }, 60_000);
});
