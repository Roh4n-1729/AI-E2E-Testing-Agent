import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { runStep } from '../../src/executor/replayExecutor.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, testConfig } from './harness.js';

// Three pickers: an image behind a styled button (how most apps do it), a CSV input, and a video nobody has.
const PAGE = `<!doctype html><title>Upload</title>
<button id="pick">Choose image</button><input id="img" type="file" accept="image/*" hidden>
<label>Data <input id="csv" type="file" accept=".csv,text/csv"></label>
<button id="vid-btn">Choose video</button><input id="vid" type="file" accept="video/*" hidden>
<p id="out">No file</p>
<script>
  pick.onclick = () => img.click();
  document.getElementById('vid-btn').onclick = () => vid.click();
  for (const el of [img, csv, vid])
    el.onchange = () => { const f = el.files[0]; out.textContent = 'Got ' + f.name + ' (' + f.type + ', ' + f.size + ' bytes)'; };
</script>`;

/** @type {http.Server} */
let server;
let base = '';
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});
afterAll(() => server?.close());

async function open() {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-up-'));
  return BrowserSession.open(
    testConfig({ outDir: out }),
    new RunArtifacts(out, 'u').forTest('t'),
    silentLogger,
  );
}

/** A click from another driver, the way Stagehand clicks: raw CDP input events, not Playwright's API. */
async function cdpClick(/** @type {BrowserSession} */ s, /** @type {string} */ selector) {
  const box = await s.page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const cdp = await s.context.newCDPSession(s.page);
  const at = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    button: /** @type {const} */ ('left'),
    clickCount: 1,
  };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
  await cdp.detach();
}

describe.skipIf(!hasChromium)('file pickers are answered by the harness', () => {
  it('gives an image picker the sample image, even when another driver clicked', async () => {
    const s = await open();
    /** @type {import('../../src/core/types.js').UploadRecord[]} */
    const seen = [];
    s.onUpload = (u) => seen.push(u);
    try {
      await s.goto(base);
      await cdpClick(s, '#pick');
      await s.page.getByText(/^Got sample\.jpg/).waitFor({ timeout: 5000 });
      expect(await s.page.locator('#out').textContent()).toMatch(
        /Got sample\.jpg \(image\/jpeg, \d+ bytes\)/,
      );
      expect(seen).toEqual([expect.objectContaining({ accept: 'image/*', file: 'sample.jpg' })]);
      const ev = await s.collectEvidence();
      expect(ev.uploads?.[0]).toMatchObject({ file: 'sample.jpg' });
      expect((await s.harnessStatus()).fileUploads?.[0]).toMatchObject({ file: 'sample.jpg' });
    } finally {
      await s.close();
    }
  });

  it('answers the same picker the same way on a replay, and matches the accept list', async () => {
    const s = await open();
    try {
      await s.goto(base);
      await runStep(s.page, {
        index: 1,
        kind: 'act',
        description: 'choose the data file',
        method: 'click',
        selector: 'xpath=//*[@id="csv"]',
        arguments: [],
      });
      await s.page.getByText(/^Got sample\.csv/).waitFor({ timeout: 5000 });
    } finally {
      await s.close();
    }
  });

  it('records a picker it cannot answer, so the evidence says why the page is stuck', async () => {
    const s = await open();
    try {
      await s.goto(base);
      await s.page.locator('#vid-btn').click();
      await s.page.waitForTimeout(500);
      const ev = await s.collectEvidence();
      expect(ev.uploads?.[0]).toMatchObject({ accept: 'video/*' });
      expect(ev.uploads?.[0]?.error).toMatch(/no sample file fits "video\/\*"/);
      expect(await s.page.locator('#out').textContent()).toBe('No file');
    } finally {
      await s.close();
    }
  });
});
