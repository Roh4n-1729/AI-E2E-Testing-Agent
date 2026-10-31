import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLanguageModelV2 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';
import { nullEvents } from '../../src/events/runEvents.js';
import { LoopAgentExecutor } from '../../src/executor/loopAgentExecutor.js';
import { runStep } from '../../src/executor/replayExecutor.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, testConfig } from './harness.js';

// Two identical "Add to cart" buttons (the second one is the one to press), a quantity box and a sort menu.
const SHOP = `<!doctype html><html lang="en"><head><title>Shop</title></head><body><main>
<h1>Shop</h1><p id="cart">Cart (0)</p>
<div><h2>Mug</h2><button onclick="add()">Add to cart</button></div>
<div><h2>Lamp</h2><button onclick="add(); document.getElementById('last').textContent='Lamp added'">Add to cart</button></div>
<label>Note <input id="note"></label>
<label>Sort <select><option value="az">Name</option><option value="price">Price</option></select></label>
<p id="last"></p></main>
<script>let n = 0; function add() { n++; document.getElementById('cart').textContent = 'Cart (' + n + ')'; }</script>
</body></html>`;

/** @type {import('node:http').Server} */
let server;
let base = '';
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(SHOP);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
afterAll(() => server.close());

/** The latest snapshot the model was shown, from the prompt it receives. @param {any[]} prompt */
function lastTree(prompt) {
  for (let i = prompt.length - 1; i >= 0; i--)
    for (const part of prompt[i].content ?? [])
      if (part.type === 'tool-result' && part.toolName === 'snapshot')
        return JSON.stringify(part.output);
  return '';
}
/** ref of the n-th element whose snapshot line matches. @param {string} tree @param {RegExp} re */
const refOf = (tree, re, n = 0) =>
  [
    ...tree
      .replaceAll('\\"', '"')
      .matchAll(new RegExp(`${re.source}[^\\n]*?\\[ref=(e\\d+)\\]`, 'g')),
  ][n]?.[1];

/**
 * A scripted model: reads the page, clicks the SECOND "Add to cart", types a note, sorts by price,
 * then finishes. It finds refs in the snapshot it was given, exactly as a real model would.
 */
function scriptedModel(/** @type {any[][]} */ prompts = []) {
  let call = 0;
  return new MockLanguageModelV2({
    doGenerate: async ({ prompt }) => {
      prompts.push(structuredClone(prompt));
      const tree = lastTree(prompt);
      /** @type {[string, Record<string, unknown>][]} */
      const plan = [
        ['snapshot', {}],
        [
          'click',
          {
            ref: refOf(tree, /button "Add to cart"/, 1),
            element: 'the Add to cart button of the Lamp',
          },
        ],
        ['snapshot', {}],
        ['type', { ref: refOf(tree, /textbox "Note"/), element: 'the Note field', text: 'gift' }],
        [
          'select',
          { ref: refOf(tree, /combobox "Sort"/), element: 'the Sort menu', value: 'price' },
        ],
        [
          'finish',
          { status: 'done', summary: 'Added the lamp', observed: ['Cart (1)', 'Lamp added'] },
        ],
      ];
      const [toolName, input] = plan[call++] ?? [
        'finish',
        { status: 'blocked', summary: 'out of script', observed: [] },
      ];
      return {
        finishReason: 'tool-calls',
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        content: [
          { type: 'tool-call', toolCallId: `c${call}`, toolName, input: JSON.stringify(input) },
        ],
        warnings: [],
      };
    },
  });
}

describe.skipIf(!hasChromium)('our own agent loop (AIE2E_AGENT_ENGINE=loop)', () => {
  it('acts by snapshot refs, records Playwright locators, and the recording replays without a model', async () => {
    const cfg = testConfig({
      outDir: mkdtempSync(path.join(os.tmpdir(), 'aie2e-loop-')),
      agentEngine: 'loop',
    });
    const artifacts = new RunArtifacts(cfg.outDir, 'r1').forTest('t');
    const s = await BrowserSession.open(cfg, artifacts, silentLogger);
    try {
      /** @type {any[][]} */
      const prompts = [];
      const exec = new LoopAgentExecutor(cfg, { model: scriptedModel(prompts) });
      const test = {
        id: 't',
        title: 'Add the lamp',
        goal: 'Add the Lamp to the cart, note "gift", sort by price',
        startUrl: `${base}/`,
        expectations: [],
        tags: [],
      };
      const out = await exec.execute(test, s, {
        runId: 'r1',
        testId: 't',
        artifacts,
        logger: silentLogger,
        events: nullEvents,
      });
      expect(out.error).toBeUndefined();
      expect(out.mode).toBe('agent');
      expect(out.agentClaim).toMatchObject({
        success: true,
        status: 'done',
        message: 'Added the lamp',
      });
      expect(out.recordable).toBe(true);
      expect(await s.page.locator('#cart').textContent()).toBe('Cart (1)');
      expect(await s.page.locator('#last').textContent()).toBe('Lamp added');
      expect(out.llmUsage?.inputTokens).toBeGreaterThan(0);
      // The conversation is only ever appended to: thinking models sign each thinking block against
      // everything before it, so rewriting an earlier message gets the call rejected (first real run).
      for (let i = 1; i < prompts.length; i++)
        expect(prompts[i].slice(0, prompts[i - 1].length)).toEqual(prompts[i - 1]);

      // replayable steps with Playwright's own locators: the second button, by role and position
      const acts = out.steps.filter((x) => x.kind === 'act');
      expect(acts.map((x) => x.method)).toEqual(['click', 'fill', 'selectOption']);
      // Playwright picks the locator: here "the Add to cart button in the block that says Lamp", no XPath

      console.log('SEL', JSON.stringify(acts.map((a) => a.selector)));
      expect(acts[0]?.selector).toContain('Lamp');
      expect(acts[1]?.selector).toMatch(/Note/);
      // the trace: harness open, then the actions with screenshots; looks are marked as observations
      const actions = (out.trace ?? []).filter((t) => t.source === 'agent' && !t.observe);
      expect(actions.map((t) => t.tool)).toEqual(['click', 'type', 'select']);
      expect(actions.every((t) => t.screenshot)).toBe(true);

      // the recording replays with plain Playwright, no model
      await s.goto(`${base}/`);
      for (const step of out.steps.slice(1)) await runStep(s.page, step);
      expect(await s.page.locator('#cart').textContent()).toBe('Cart (1)');
      expect(await s.page.locator('#last').textContent()).toBe('Lamp added');
      expect(await s.page.locator('#note').inputValue()).toBe('gift');
      expect(await s.page.locator('select').inputValue()).toBe('price');
    } finally {
      await s.close();
    }
  });

  it('a stale ref is reported back to the model, not thrown', async () => {
    const cfg = testConfig({ outDir: mkdtempSync(path.join(os.tmpdir(), 'aie2e-loop-')) });
    const artifacts = new RunArtifacts(cfg.outDir, 'r2').forTest('t');
    const s = await BrowserSession.open(cfg, artifacts, silentLogger);
    try {
      let call = 0;
      /** @type {any} */
      let seen;
      const model = new MockLanguageModelV2({
        doGenerate: async ({ prompt }) => {
          call++;
          if (call === 2) seen = prompt.at(-1);
          const [toolName, input] =
            call === 1
              ? ['click', { ref: 'e999', element: 'a button that is not there' }]
              : ['finish', { status: 'blocked', summary: 'no button', observed: [] }];
          return {
            finishReason: 'tool-calls',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            content: [
              { type: 'tool-call', toolCallId: `c${call}`, toolName, input: JSON.stringify(input) },
            ],
            warnings: [],
          };
        },
      });
      const out = await new LoopAgentExecutor(cfg, { model }).execute(
        { id: 't', title: 'x', goal: 'click it', startUrl: `${base}/`, expectations: [], tags: [] },
        s,
        { runId: 'r2', testId: 't', artifacts, logger: silentLogger, events: nullEvents },
      );
      expect(JSON.stringify(seen)).toContain('Take a new snapshot');
      expect(out.agentClaim).toMatchObject({ success: false, status: 'blocked' });
      expect(out.recordable).toBe(false);
    } finally {
      await s.close();
    }
  });
});
