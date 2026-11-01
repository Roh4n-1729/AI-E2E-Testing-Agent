import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { dragAtTool } from '../../src/executor/agentExecutor.js';
import { runStep } from '../../src/executor/replayExecutor.js';
import { actionsToSteps } from '../../src/executor/steps.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, testConfig } from './harness.js';

// A crop box whose bottom-right handle is a bare div: no role, no name, nothing to drop it on. Pointer events,
// a small threshold before a drag starts, like most crop and slider libraries.
const PAGE = `<!doctype html><title>Crop</title><style>body{margin:0}
#box{position:absolute;left:100px;top:100px;width:400px;height:300px;outline:2px dashed #333}
#h{position:absolute;right:-8px;bottom:-8px;width:16px;height:16px;background:#09f;cursor:nwse-resize}</style>
<div id="box"><div id="h"></div></div><p id="size" style="position:absolute;top:10px;left:10px">400x300</p>
<script>
  let start = null;
  h.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, w: box.offsetWidth, h: box.offsetHeight }; e.preventDefault(); });
  addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) < 3) return;
    box.style.width = Math.max(40, start.w + dx) + 'px'; box.style.height = Math.max(40, start.h + dy) + 'px';
    size.textContent = box.offsetWidth + 'x' + box.offsetHeight;
  });
  addEventListener('pointerup', () => { start = null; });
</script>`;

/** @type {http.Server} */
let server;
let base = '';
beforeAll(async () => {
  server = http.createServer((_q, r) => {
    r.setHeader('content-type', 'text/html');
    r.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});
afterAll(() => server?.close());

async function open() {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-drag-'));
  return BrowserSession.open(
    testConfig({ outDir: out }),
    new RunArtifacts(out, 'd').forTest('t'),
    silentLogger,
  );
}

// the handle's centre is at (500, 400) in a 1280x800 viewport: 39.06%, 50%
const FROM = { fromXPercent: 39.06, fromYPercent: 50 };
const TO = { toXPercent: 31.25, toYPercent: 37.5 }; // (400, 300): 100 px inward each way

describe.skipIf(!hasChromium)('dragging by position', () => {
  it('the agent can drag a handle with no name inward, and the recorded step replays the same drag', async () => {
    const s = await open();
    try {
      await s.goto(base);
      const tool = /** @type {any} */ (dragAtTool(s));
      expect(await tool.execute({ ...FROM, ...TO, what: 'the crop corner inward' }, {})).toEqual({
        ok: true,
      });
      expect(await s.page.locator('#size').textContent()).toBe('300x200');

      const { steps, recordable } = actionsToSteps(
        [
          {
            type: 'act',
            playwrightArguments: {
              selector: 'xpath=/html/body',
              method: 'click',
              description: 'x',
            },
          },
          { type: 'dragAt', ...FROM, ...TO, what: 'the crop corner inward' },
        ],
        0,
      );
      expect(recordable).toBe(true);
      expect(steps[1]).toMatchObject({
        kind: 'mouse',
        method: 'drag',
        arguments: ['39.1', '50', '31.3', '37.5'],
      });

      await s.goto(base); // fresh page: replay only the drag
      await runStep(s.page, steps[1]);
      expect(await s.page.locator('#size').textContent()).toMatch(/^(299|300|301)x(199|200|201)$/);
    } finally {
      await s.close();
    }
  });
});
