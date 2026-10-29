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
          { kind: 'url-contains', value: '/cart' },
          { kind: 'text-visible', value: 'Your cart' },
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
    expect(cart?.expectations).toEqual([
      { kind: 'url', pattern: '/cart', mode: 'includes' },
      { kind: 'text-visible', text: 'Your cart' },
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
    expect(tests[1]?.expectations).toEqual([
      { kind: 'download', filenamePattern: '.pptx' },
      { kind: 'text-appeared', text: 'PowerPoint file downloaded' },
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
