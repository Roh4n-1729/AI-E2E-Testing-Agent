import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from '../../src/config/config.js';
import { buildPipeline } from '../../src/core/pipeline.js';
import { TestRunner } from '../../src/core/testRunner.js';
import { AgentExecutor } from '../../src/executor/agentExecutor.js';
import { EvidenceJudge } from '../../src/judge/evidenceJudge.js';
import { CompositeReporter } from '../../src/reporter/compositeReporter.js';
import { HtmlReporter } from '../../src/reporter/htmlReporter.js';
import { JsonReporter } from '../../src/reporter/jsonReporter.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';

/** True when a Chromium is available (set AIE2E_CHROME_PATH to use a specific binary). */
export const hasChromium = (() => {
  try {
    return existsSync(process.env.AIE2E_CHROME_PATH ?? chromium.executablePath());
  } catch {
    return false;
  }
})();

/** @param {Partial<import('../../src/config/config.js').ConfigInput>} [over] */
export function testConfig(over = {}) {
  return loadConfig(
    {
      logLevel: 'silent',
      chromePath: process.env.AIE2E_CHROME_PATH,
      chromeArgs: process.env.AIE2E_CHROME_ARGS?.split(' '),
      ...over,
    },
    {},
  );
}

/** A tiny multi-page app: home, about, products (with a console error), and a logout link. */
export function startApp() {
  /** @type {string[]} */
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push(url);
    res.setHeader('content-type', 'text/html');
    const nav =
      '<nav><a href="/about">About us</a> <a href="/products">Products</a> <a href="/logout">Log out</a> <a href="/delete-account">Delete account</a> <a href="https://other.example/x">External</a> <a href="/file.pdf">PDF</a></nav>';
    if (url === '/api/generate' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      return void setTimeout(() => res.end('{"n":3}'), 120);
    }
    if (url === '/pixel.gif') {
      res.setHeader('content-type', 'image/gif');
      return void res.end(
        Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
      );
    }
    if (url === '/report.csv') {
      res.setHeader('content-type', 'text/csv');
      res.setHeader('content-disposition', 'attachment; filename="report.csv"');
      return void res.end('a,b\n1,2\n');
    }
    if (url === '/lab')
      return void res.end(`<!doctype html><html lang="en"><head><title>Lab</title></head><body>
<h1>Lab</h1>
<button id="gen" onclick="fetch('/api/generate',{method:'POST'}).then(r=>r.json()).then(j=>{document.getElementById('out').textContent='Generated '+j.n})">Generate</button>
<button id="exp" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['hello'],{type:'text/plain'}));a.download='deck.pptx';a.click();const t=document.createElement('div');t.setAttribute('role','status');t.textContent='Deck downloaded';document.body.appendChild(t);setTimeout(()=>t.remove(),250)">Export</button>
<a id="csv" href="/report.csv">Download CSV</a>
<p id="out"></p>
<img src="/pixel.gif"><!-- no alt text: an accessibility violation -->
</body></html>`);
    if (url === '/present')
      return void res.end(`<!doctype html><html lang="en"><head><title>Present</title>
<style>body{margin:0;height:100vh;background:#111;color:#fff}#bar{position:fixed;right:10px;bottom:10px;display:none}</style></head><body>
<h1>Slide 1</h1><div id="bar"><button id="exit" onclick="document.title='Exited'">Exit</button></div>
<script>addEventListener('mousemove',e=>{if(e.clientX>innerWidth*0.7&&e.clientY>innerHeight*0.7)document.getElementById('bar').style.display='block'})</script></body></html>`);
    if (url === '/spa')
      return void res.end(`<!doctype html><html lang="en"><head><title>SPA</title></head><body><div id="root"></div>
<script>setTimeout(()=>{document.getElementById('root').innerHTML='<h1>Rendered late</h1><button id="go">Go</button>'},700)</script></body></html>`);
    if (url === '/hinted')
      return void res.end(`<!doctype html><html lang="en"><head><title>Hinted</title>
<style>#bar{position:fixed;right:10px;bottom:10px;opacity:0}#bar:hover{opacity:1}</style></head><body>
<h1>Deck</h1>
<button data-testid="export" onclick="this.closest('body').setAttribute('aria-busy','true');setTimeout(()=>{document.body.removeAttribute('aria-busy');document.getElementById('out').textContent='Exported'},900)"><span>Export</span></button>
<p id="out"></p>
<div id="bar" data-aie2e-reveal="hover" data-aie2e-hint="Presentation controls appear when the mouse is over the bottom-right corner">
  <button data-testid="exit" onclick="document.title='Exited'">Exit</button>
</div>
</body></html>`);
    if (url === '/dup')
      // a hidden copy of the text comes FIRST in the DOM, as with closed menus or off-screen slides
      return void res.end(`<!doctype html><html lang="en"><head><title>Dup</title></head><body>
<div class="msg" style="display:none">Order placed</div><p class="msg">Welcome</p>
<button id="place" onclick="document.getElementById('out').textContent='Order placed'">Place order</button><p id="out"></p>
</body></html>`);
    if (url === '/anim')
      return void res.end(`<!doctype html><html lang="en"><head><title>Anim</title><style>
@keyframes spin{to{transform:rotate(360deg)}}#s{width:120px;height:120px;margin:60px;background:#e96c2f;animation:spin 1s linear infinite}</style></head><body><h1>Anim</h1><div id="s"></div></body></html>`);
    if (url === '/shop')
      res.end(
        `<title>Shop</title>${nav}<h1>Shop</h1><button id="add" onclick="document.getElementById('out').textContent='Added to cart'">Add to cart</button><button id="noop">Noop</button><p id="out"></p>`,
      );
    else if (url === '/about') res.end(`<title>About</title>${nav}<h1>About our team</h1>`);
    else if (url === '/products')
      res.end(
        `<title>Products</title>${nav}<h1>Our products</h1><button>Add to cart</button><script>console.error("boom")</script>`,
      );
    else if (url === '/missing') {
      res.statusCode = 404;
      res.end('nope');
    } else if (url === '/broken')
      res.end('<h1>Broken</h1><script>console.error("boom"); fetch("/missing")</script>');
    else if (url === '/logout' || url === '/delete-account') res.end('should never be crawled');
    else res.end(`<title>Home</title>${nav}<h1>Welcome home</h1><form></form>`);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ server, hits, base: `http://127.0.0.1:${port}` });
    }),
  );
}

/**
 * Full pipeline with real browser, given a planner, crawler and optional LLM.
 * @param {{ planner: import('../../src/core/ports.js').Planner, crawler: import('../../src/core/ports.js').Crawler, url: string, llm?: import('../../src/core/ports.js').LlmClient, concurrency?: number }} o
 */
export async function runPipeline({ planner, crawler, url, llm, concurrency = 1 }) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-'));
  const config = testConfig({ outDir: out, concurrency });
  const artifacts = new RunArtifacts(out, 'test-run');
  await artifacts.init();
  const pipeline = buildPipeline({
    config,
    logger: silentLogger,
    crawler,
    planner,
    reporter: new CompositeReporter([
      new JsonReporter(artifacts, silentLogger),
      new HtmlReporter(artifacts, silentLogger),
    ]),
    runner: new TestRunner({
      config,
      logger: silentLogger,
      artifacts,
      executor: new AgentExecutor(config),
      judge: new EvidenceJudge(config.judge, llm),
    }),
  });
  const state = await pipeline.invoke({
    runId: 'test-run',
    startedAt: new Date().toISOString(),
    target: { url },
    tests: [],
    results: [],
  });
  return {
    report: /** @type {import('../../src/core/types.js').RunReport} */ (state.report),
    artifacts,
  };
}
