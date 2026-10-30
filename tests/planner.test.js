import { describe, expect, it } from 'vitest';
import { LlmPlanner } from '../src/planner/llmPlanner.js';
import { StaticPlanner } from '../src/planner/staticPlanner.js';
import { TestCaseSchema } from '../src/core/types.js';
import { silentLogger } from '../src/util/logger.js';
import { mockLlm } from './helpers.js';

const siteMap = {
  origin: 'https://shop.test',
  pages: [
    {
      url: 'https://shop.test/',
      title: 'Shop',
      links: ['https://shop.test/cart'],
      textExcerpt: 'Welcome to the shop',
      buttons: ['Add to cart'],
    },
  ],
};

describe('LlmPlanner', () => {
  const llmOutput = {
    tests: [
      {
        title: 'Add item to cart',
        goal: 'Click Add to cart on the first product, then open the cart',
        expectations: [
          { kind: 'url-contains', value: '/cart', label: 'The cart opens' },
          { kind: 'text-visible', value: 'Your cart', label: 'The cart heading is shown' },
          { kind: 'visual', value: 'Does the page show one item in the cart?' },
        ],
      },
      { title: 'Add item to cart', goal: 'Duplicate title', expectations: [] },
    ],
  };

  it('always starts with a smoke test, then maps LLM tests to valid TestCases', async () => {
    const spy = { calls: /** @type {unknown[]} */ ([]) };
    const planner = new LlmPlanner(mockLlm(llmOutput, spy), { maxTests: 5 }, silentLogger);
    const tests = await planner.plan({ url: 'https://shop.test/', description: 'A shop' }, siteMap);

    expect(tests.map((t) => t.id)).toEqual(['smoke', 'add-item-to-cart', 'add-item-to-cart-2']);
    expect(tests[0]?.goal).toBe('');
    for (const t of tests) expect(TestCaseSchema.safeParse(t).success).toBe(true);

    const cart = tests[1];
    // "Your cart" appears nowhere in the crawl: a guessed wording becomes a question about the screenshots
    expect(cart?.expectations).toEqual([
      // labels (plain words for the report) survive grounding and repair
      { kind: 'url', pattern: '/cart', mode: 'includes', label: 'The cart opens' },
      {
        kind: 'visual',
        question:
          'After the action, does the page show that it succeeded (a confirmation, an updated count or new content)?',
        label: 'The cart heading is shown',
      },
      { kind: 'visual', question: 'Does the page show one item in the cart?' },
      { kind: 'no-console-errors' },
      { kind: 'no-network-failures' },
    ]);
    // The prompt is grounded in the crawl and the description.
    const sent = JSON.stringify(spy.calls[0]);
    expect(sent).toContain('Add to cart');
    expect(sent).toContain('A shop');
  });

  it('respects maxTests', async () => {
    const planner = new LlmPlanner(mockLlm(llmOutput), { maxTests: 1 }, silentLogger);
    const tests = await planner.plan({ url: 'https://shop.test/' }, siteMap);
    expect(tests).toHaveLength(2); // smoke + 1
  });

  it('surfaces LLM failures instead of silently degrading', async () => {
    const planner = new LlmPlanner(
      { generateObject: async () => Promise.reject(new Error('no api key')) },
      { maxTests: 3 },
      silentLogger,
    );
    await expect(planner.plan({ url: 'https://shop.test/' }, siteMap)).rejects.toThrow(
      'no api key',
    );
  });
});

describe('StaticPlanner', () => {
  it('makes a smoke test without a goal and a goal test with expectations', async () => {
    const p = new StaticPlanner();
    const [smoke] = await p.plan({ url: 'https://a.test/' }, siteMap);
    expect(smoke?.id).toBe('smoke');
    const [t] = await p.plan(
      {
        url: 'https://a.test/',
        goal: 'Open pricing',
        expectUrl: '/pricing',
        expectText: ['Plans'],
      },
      siteMap,
    );
    expect(t?.expectations.map((e) => e.kind)).toEqual([
      'url',
      'text-visible',
      'no-console-errors',
      'no-network-failures',
    ]);
  });

  it('drops guessed URLs and endpoints, keeps grounded ones, and never leaves a test without an outcome check', async () => {
    const out = {
      tests: [
        {
          title: 'Export the deck',
          goal: 'In the editor, open Export and choose PowerPoint',
          expectations: [
            { kind: 'url-contains', value: 'download' }, // guessed: the crawl never saw it
            { kind: 'download', value: '.pptx' },
            { kind: 'text-appeared', value: 'PowerPoint file downloaded' },
            { kind: 'api-call', value: 'POST /api/guess' }, // not in the crawl
          ],
        },
        {
          title: 'Open the cart',
          goal: 'Open the cart page',
          expectations: [{ kind: 'url-contains', value: '/nowhere' }],
        },
      ],
    };
    const planner = new LlmPlanner(mockLlm(out), { maxTests: 5 }, silentLogger);
    const tests = await planner.plan({ url: 'https://shop.test/' }, siteMap);
    // the toast wording was never seen in the crawl: a guess, turned into a question about the screenshots
    expect(tests[1]?.expectations).toEqual([
      { kind: 'download', filenamePattern: '.pptx' },
      {
        kind: 'visual',
        question:
          'After the action, does the page show that it succeeded (a confirmation, an updated count or new content)?',
      },
      { kind: 'no-console-errors' },
      { kind: 'no-network-failures' },
    ]);
    // everything was dropped -> falls back to a visual question about the goal
    expect(tests[2]?.expectations[0]).toMatchObject({ kind: 'visual' });
  });

  it('keeps an api-call that the crawl actually saw on load', async () => {
    const mapWithApi = {
      ...siteMap,
      pages: [{ ...siteMap.pages[0], apiCalls: ['GET /api/products'] }],
    };
    const out = {
      tests: [
        {
          title: 'Products load',
          goal: 'Open the shop',
          expectations: [{ kind: 'api-call', value: 'GET /api/products' }],
        },
      ],
    };
    const planner = new LlmPlanner(mockLlm(out), { maxTests: 5 }, silentLogger);
    const tests = await planner.plan({ url: 'https://shop.test/' }, mapWithApi);
    expect(tests[1]?.expectations[0]).toEqual({
      kind: 'api-call',
      urlPattern: '/api/products',
      method: 'GET',
    });
  });
});

describe('plan review: checks grounded in what the crawler saw', () => {
  const shop = {
    origin: 'https://shop.test',
    pages: [
      {
        url: 'https://shop.test/',
        title: 'Shop',
        links: ['https://shop.test/cart'],
        textExcerpt: 'Coffee Mug ₹299 Notebook ₹149 Cart (0) Newsletter',
        buttons: ['Add to cart', 'Subscribe'],
      },
      {
        url: 'https://shop.test/cart',
        title: 'Cart',
        links: [],
        textExcerpt: 'Your cart is empty. Total: ₹0',
      },
    ],
  };

  it('flags start-page text and guessed wording, accepts counters and totals in a new state', async () => {
    const { reviewExpectations } = await import('../src/planner/llmPlanner.js');
    const r = reviewExpectations(
      [
        { kind: 'text-visible', text: 'Coffee Mug' }, // on the home page already
        { kind: 'text-appeared', text: 'Thank you' }, // never seen: a guess
        { kind: 'text-visible', text: 'Cart (2)' }, // the crawl saw "Cart (0)"
        { kind: 'text-visible', text: 'Total: ₹448' }, // the crawl saw "Total: ₹0"
        { kind: 'url', pattern: '/', mode: 'includes' }, // true at the start URL
      ],
      shop,
      'https://shop.test/',
    );
    expect(r.issues).toHaveLength(3);
    expect(r.issues.join(' ')).toContain('"Coffee Mug" is already on the start page');
    expect(r.issues.join(' ')).toContain('"Thank you" appears nowhere in the crawl');
    expect(r.repaired.map((e) => (e.kind === 'text-visible' ? e.text : e.kind))).toEqual([
      'visual',
      'Cart (2)',
      'Total: ₹448',
    ]);
  });

  it('gives the planner one revision round with the findings, and uses the revised plan', async () => {
    const weak = {
      tests: [
        {
          title: 'Add two products',
          goal: 'Add the Coffee Mug and the Notebook, then open the cart',
          expectations: [{ kind: 'text-visible', value: 'Coffee Mug' }],
        },
      ],
    };
    const fixed = {
      tests: [
        {
          title: 'Add two products',
          goal: 'Add the Coffee Mug and the Notebook, then open the cart',
          expectations: [
            { kind: 'text-visible', value: 'Cart (2)' },
            { kind: 'url-contains', value: '/cart' },
          ],
        },
      ],
    };
    /** @type {string[]} */
    const prompts = [];
    let n = 0;
    const llm = {
      /** @param {{ prompt: string }} req */
      generateObject: async (req) => {
        prompts.push(req.prompt);
        return /** @type {any} */ (n++ === 0 ? weak : fixed);
      },
    };
    const planner = new LlmPlanner(/** @type {any} */ (llm), { maxTests: 3 }, silentLogger);
    const tests = await planner.plan({ url: 'https://shop.test/' }, shop);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"Coffee Mug" is already on the start page');
    expect(tests[1]?.expectations.slice(0, 2)).toEqual([
      { kind: 'text-visible', text: 'Cart (2)' },
      { kind: 'url', pattern: '/cart', mode: 'includes' },
    ]);
  });

  it('repairs what the revision still gets wrong, and never asks twice', async () => {
    const stubborn = {
      tests: [
        {
          title: 'Subscribe',
          goal: 'Enter test@example.com in the newsletter form and click Subscribe',
          expectations: [{ kind: 'text-appeared', value: 'Thank you' }],
        },
      ],
    };
    let calls = 0;
    const llm = {
      generateObject: async () => {
        calls++;
        return /** @type {any} */ (stubborn);
      },
    };
    const planner = new LlmPlanner(/** @type {any} */ (llm), { maxTests: 3 }, silentLogger);
    const [, t] = await planner.plan({ url: 'https://shop.test/' }, shop);
    expect(calls).toBe(2);
    expect(t?.expectations[0]?.kind).toBe('visual');
  });
});
