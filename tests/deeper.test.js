import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import {
  crawledScreens,
  discoverScreens,
  reachDirectly,
  routeOf,
  similarity,
  seenScreen,
} from '../src/core/discovery.js';
import { buildPipeline } from '../src/core/pipeline.js';
import { TestCaseSchema } from '../src/core/types.js';
import { LlmPlanner } from '../src/planner/llmPlanner.js';
import { testFingerprint } from '../src/storage/recordStore.js';
import { silentLogger } from '../src/util/logger.js';
import { sha256 } from '../src/util/misc.js';
import { mockLlm } from './helpers.js';

/** @typedef {import('../src/core/types.js').TestCase} TestCase */
/** @typedef {import('../src/core/types.js').TestResult} TestResult */
/** @typedef {import('../src/core/types.js').RecordedStep} RecordedStep */

const ORIGIN = 'https://shop.test';
const siteMap = {
  origin: ORIGIN,
  pages: [
    {
      url: `${ORIGIN}/`,
      title: 'Shop',
      links: [`${ORIGIN}/about`],
      textExcerpt: 'Welcome to the shop Backpack 29.99 Add to cart Cart (0)',
      buttons: ['Add to cart'],
    },
  ],
};

/** @param {string} id @param {Partial<TestCase>} [over] @returns {TestCase} */
const tc = (id, over = {}) => ({
  id,
  title: `Test ${id}`,
  goal: `Do ${id}`,
  startUrl: `${ORIGIN}/`,
  expectations: [],
  tags: [],
  ...over,
});

/**
 * @param {TestCase} test @param {'pass' | 'fail'} status @param {string} finalUrl @param {string} text
 * @param {string[]} [buttons]
 * @returns {TestResult}
 */
const result = (test, status, finalUrl, text, buttons = ['Checkout', 'Continue shopping']) => ({
  test,
  mode: 'agent',
  verdict: { status, reason: '', checks: [], warnings: [] },
  evidence: {
    finalUrl,
    title: 'Shop',
    pageTextExcerpt: text,
    screenshots: [],
    console: [],
    networkFailures: [],
    screen: {
      buttons,
      links: [`${ORIGIN}/checkout-step-one`],
      forms: 0,
      testIds: ['[data-test="checkout"] "Checkout"'],
      hints: [],
      apiCalls: ['POST /api/cart'],
    },
  },
  claimMismatch: false,
  heals: [],
  durationMs: 1,
});

/** @type {RecordedStep[]} */
const STEPS = [
  { index: 0, kind: 'navigate', description: 'Open the shop', url: `${ORIGIN}/` },
  { index: 1, kind: 'act', description: 'Click Add to cart', selector: '#add', method: 'click' },
  { index: 2, kind: 'act', description: 'Open the cart', selector: '#cart', method: 'click' },
];
const stepsFor = async () => STEPS;
const CART = 'Your Cart QTY Description Backpack 29.99 Remove Checkout Continue shopping';

describe('discovery: new screens the passing tests reached', () => {
  it('turns a passing, recorded test that ended on an unseen screen into a starting point', async () => {
    const known = crawledScreens(siteMap);
    const screens = await discoverScreens({
      results: [result(tc('cart'), 'pass', `${ORIGIN}/cart`, CART)],
      known,
      stepsFor,
      origin: ORIGIN,
      max: 4,
    });
    expect(screens).toHaveLength(1);
    expect(screens[0]).toMatchObject({
      url: `${ORIGIN}/cart`,
      from: { testId: 'cart', title: 'Test cart' },
      steps: STEPS,
      page: { buttons: ['Checkout', 'Continue shopping'], apiCalls: ['POST /api/cart'] },
    });
    expect(known).toHaveLength(2); // remembered, so a later round does not find it again
  });

  it('skips failed tests, smoke tests, other origins, unrecorded runs and screens already known', async () => {
    const known = crawledScreens(siteMap);
    const screens = await discoverScreens({
      results: [
        result(tc('failed'), 'fail', `${ORIGIN}/cart`, CART),
        result(tc('smoke', { goal: '' }), 'pass', `${ORIGIN}/cart`, CART),
        result(tc('away'), 'pass', 'https://elsewhere.test/cart', CART),
        // the crawled home page with a different cart count is the same screen
        result(
          tc('home'),
          'pass',
          `${ORIGIN}/`,
          'Welcome to the shop Backpack 29.99 Add to cart Cart (3)',
          ['Add to cart'],
        ),
      ],
      known,
      stepsFor,
      origin: ORIGIN,
      max: 4,
    });
    expect(screens).toEqual([]);
    const none = await discoverScreens({
      results: [result(tc('cart'), 'pass', `${ORIGIN}/cart`, CART)],
      known,
      stepsFor: async () => null, // no recording for this exact test
      origin: ORIGIN,
      max: 4,
    });
    expect(none).toEqual([]);
  });

  it('counts two tests ending on the same screen once, and stops at the budget', async () => {
    const screens = await discoverScreens({
      results: [
        result(tc('a'), 'pass', `${ORIGIN}/cart`, CART),
        result(tc('b'), 'pass', `${ORIGIN}/cart`, `${CART} `),
        result(tc('c'), 'pass', `${ORIGIN}/checkout`, 'Your information First name Last name'),
        result(tc('d'), 'pass', `${ORIGIN}/orders`, 'Your orders none yet'),
      ],
      known: crawledScreens(siteMap),
      stepsFor,
      origin: ORIGIN,
      max: 2,
    });
    expect(screens.map((s) => s.from.testId)).toEqual(['a', 'c']);
  });

  it('names a route by its kind of page, not the record it shows', () => {
    expect(routeOf(`${ORIGIN}/deck/d_mvx951ic6i8i`)).toBe('/deck/:id');
    expect(routeOf(`${ORIGIN}/deck/d_mvx951ic6i8i/present/1`)).toBe('/deck/:id/present/:id');
    expect(routeOf(`${ORIGIN}/orders/2f1c9a7e-77aa-4b1e-9d1e-1f2a3b4c5d6e?tab=items`)).toBe(
      '/orders/:id?tab',
    );
    expect(routeOf(`${ORIGIN}/checkout-step-one`)).toBe('/checkout-step-one');
    expect(routeOf(`${ORIGIN}/`)).toBe('/');
  });

  it('treats two decks in the same editor as one screen, and keeps the shortest way there', async () => {
    const toolbar = ['Insert', 'Theme', 'Export', 'Present', 'Add slide'];
    /** @type {RecordedStep[]} */
    const long = [...STEPS, { index: 3, kind: 'act', description: 'More', selector: '#x' }];
    const screens = await discoverScreens({
      results: [
        result(tc('long'), 'pass', `${ORIGIN}/deck/d_aaa111`, 'Benefits of Recycling', [
          ...toolbar,
          '1The Recycling Imperative and a long slide thumbnail full of content',
        ]),
        result(tc('short'), 'pass', `${ORIGIN}/deck/d_bbb222`, 'Healthy Sleep Habits', toolbar),
        result(tc('present'), 'pass', `${ORIGIN}/deck/d_ccc333/present/1`, 'Slide 1', toolbar),
      ],
      known: crawledScreens(siteMap),
      stepsFor: async (t) => (t.id === 'long' ? long : STEPS),
      origin: ORIGIN,
      max: 4,
    });
    expect(screens.map((s) => [routeOf(s.url), s.from.testId])).toEqual([
      ['/deck/:id', 'short'],
      ['/deck/:id/present/:id', 'present'],
    ]);
  });

  it('tells screens on one URL apart by their words (a single-page app changes state, not path)', () => {
    const a = seenScreen(`${ORIGIN}/`, 'Generate a deck Topic Generate');
    const b = seenScreen(`${ORIGIN}/`, 'Slide 1 of 8 Present Export Theme Edit slide');
    expect(similarity(a.words, b.words)).toBeLessThan(0.7);
  });
});

describe('reaching a discovered screen by its address', () => {
  /** @returns {import('../src/core/discovery.js').Screen} */
  const editor = (/** @type {string} */ url, /** @type {string} */ text) => ({
    url,
    title: 'Deck',
    from: { testId: 'gen', title: 'Generate' },
    steps: STEPS,
    page: {
      url,
      title: 'Deck',
      textExcerpt: text,
      links: [],
      buttons: ['Insert', 'Theme', 'Export', 'Present'],
    },
  });

  it('starts there when a fresh browser shows the same screen, and keeps the steps when it does not', async () => {
    const shared = editor(`${ORIGIN}/deck/d_aaa111`, 'Benefits of Recycling');
    const local = editor(`${ORIGIN}/deck/d_bbb222`, 'Healthy Sleep');
    const n = await reachDirectly([shared, local], async (url) =>
      url.endsWith('aaa111')
        ? // the same editor, even if the slides render a little differently
          {
            url,
            title: 'Deck',
            text: 'Benefits of Recycling 7 slides',
            buttons: ['Insert', 'Theme', 'Export', 'Present'],
          }
        : // the deck lived only in that test's browser: the app sends a fresh browser home
          { url: `${ORIGIN}/`, title: 'Shop', text: 'Welcome', buttons: ['Generate'] },
    );
    expect(n).toBe(1);
    expect(shared.direct).toBe(true);
    expect(local.direct).toBeUndefined();
  });

  it('keeps the steps when the address cannot be opened at all', async () => {
    const sc = editor(`${ORIGIN}/deck/d_x1`, 'x');
    expect(await reachDirectly([sc], async () => null)).toBe(0);
    expect(await reachDirectly([sc], async () => Promise.reject(new Error('timeout')))).toBe(0);
    expect(sc.direct).toBeUndefined();
  });
});

describe('recordings of tests that start deeper', () => {
  it('keeps the fingerprint of every existing test, and ties a prefixed test to its prefix', () => {
    const plain = tc('plain', { expectations: [{ kind: 'url', pattern: '/x', mode: 'includes' }] });
    expect(testFingerprint(plain)).toBe(
      sha256(JSON.stringify([plain.goal, plain.startUrl, [plain.expectations[0]]])),
    );
    const deep = { ...plain, prefix: STEPS };
    expect(testFingerprint(deep)).not.toBe(testFingerprint(plain));
    expect(testFingerprint({ ...plain, prefix: STEPS.slice(0, 2) })).not.toBe(
      testFingerprint(deep),
    );
  });
});

describe('planning round 2', () => {
  const screen = {
    url: `${ORIGIN}/cart`,
    title: 'Shop',
    from: { testId: 'cart', title: 'Add to cart' },
    steps: STEPS,
    page: {
      url: `${ORIGIN}/cart`,
      title: 'Shop',
      textExcerpt: CART,
      links: [`${ORIGIN}/checkout-step-one`],
      buttons: ['Checkout', 'Remove'],
      testIds: ['[data-test="checkout"] "Checkout"'],
    },
  };
  const planned = {
    tests: [
      {
        screen: 1,
        title: 'Start checkout',
        goal: 'Click Checkout',
        expectations: [
          // grounded only by the new screen's links: the crawl never saw this URL
          { kind: 'url-contains', value: 'checkout-step-one', label: 'The checkout form opens' },
          // already on the screen this test starts on: the golden-master trap, rejected
          { kind: 'text-visible', value: '29.99' },
        ],
      },
      { screen: 7, title: 'Nowhere', goal: 'Do something', expectations: [] },
    ],
  };

  it('starts each test on its screen, grounds checks in it, and rejects what the screen already shows', async () => {
    const spy = { calls: /** @type {unknown[]} */ ([]) };
    const planner = new LlmPlanner(mockLlm(planned, spy), { maxTests: 4 }, silentLogger);
    const tests = await planner.planFrom(
      { url: `${ORIGIN}/` },
      siteMap,
      [screen],
      [tc('cart', { title: 'Add to cart' })],
      2,
    );
    expect(tests).toHaveLength(1); // screen 7 does not exist
    const [t] = tests;
    expect(TestCaseSchema.safeParse(t).success).toBe(true);
    expect(t).toMatchObject({
      id: 'start-checkout',
      startUrl: `${ORIGIN}/`,
      prefix: STEPS,
      startsFrom: { testId: 'cart', title: 'Add to cart', url: `${ORIGIN}/cart` },
      round: 2,
      tags: ['round-2'],
    });
    expect(t?.expectations).toEqual([
      {
        kind: 'url',
        pattern: 'checkout-step-one',
        mode: 'includes',
        label: 'The checkout form opens',
      },
      { kind: 'no-console-errors' },
      { kind: 'no-network-failures' },
    ]);
    // "29.99" was found on the starting screen, so the planner was asked to fix the plan once
    expect(spy.calls).toHaveLength(2);
    expect(JSON.stringify(spy.calls[1])).toContain('already on the start page');
  });

  it('asks for a rewrite of tests the AI blamed on how they were written', async () => {
    const spy = { calls: /** @type {unknown[]} */ ([]) };
    const planner = new LlmPlanner(mockLlm({ tests: [] }, spy), { maxTests: 4 }, silentLogger);
    await planner.planFrom({ url: `${ORIGIN}/` }, siteMap, [screen], [], 2, [
      {
        title: 'Improve a slide with AI',
        goal: 'Use the control that rewrites the slide',
        reading: 'The app has an AI chat panel; the agent never used it.',
      },
    ]);
    const prompt = JSON.stringify(spy.calls[0]);
    expect(prompt).toContain('failed because of how they were written');
    expect(prompt).toContain('the agent never used it');
  });

  it("starts a test at the screen's address, with no steps to replay, when it opens directly", async () => {
    const planner = new LlmPlanner(mockLlm(planned), { maxTests: 4 }, silentLogger);
    const [t] = await planner.planFrom(
      { url: `${ORIGIN}/` },
      siteMap,
      [{ ...screen, direct: true }],
      [],
      2,
    );
    expect(t?.startUrl).toBe(`${ORIGIN}/cart`);
    expect(t?.prefix).toBeUndefined();
    expect(t?.startsFrom?.testId).toBe('cart');
  });

  it('shows the planner a screenshot of each screen it has one for', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aie2e-shot-'));
    mkdirSync(path.join(dir, 'cart'));
    writeFileSync(path.join(dir, 'cart', 'final.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const spy = { calls: /** @type {any[]} */ ([]) };
    const planner = new LlmPlanner(
      mockLlm({ tests: [] }, spy),
      { maxTests: 4, imageDir: dir },
      silentLogger,
    );
    await planner.planFrom(
      { url: `${ORIGIN}/` },
      siteMap,
      [
        { ...screen, screenshot: 'cart/final.png' },
        { ...screen, url: `${ORIGIN}/x` },
      ],
      [],
      2,
    );
    const call = JSON.stringify(spy.calls[0]);
    expect(call).toContain('Screenshots are attached for screen 1, in that order');
    expect(
      spy.calls[0].prompt.at(-1).content.filter((/** @type {any} */ p) => p.type === 'file'),
    ).toHaveLength(1);
  });

  it('plans nothing without new screens', async () => {
    const planner = new LlmPlanner(mockLlm(planned), { maxTests: 4 }, silentLogger);
    expect(await planner.planFrom({ url: `${ORIGIN}/` }, siteMap, [], [], 2)).toEqual([]);
  });
});

describe('pipeline: exploring deeper', () => {
  /**
   * @param {{ rounds?: number, screensPerRound?: number[] }} o
   */
  function build({ rounds, screensPerRound = [1] }) {
    /** @type {{ type: string, data: any }[]} */
    const events = [];
    let discovered = 0;
    /** @type {number[]} */
    const plannedRounds = [];
    const pipeline = buildPipeline({
      config: loadConfig({ concurrency: 2, logLevel: 'silent' }, {}),
      logger: silentLogger,
      events: /** @type {any} */ ({
        emit: (/** @type {string} */ type, /** @type {any} */ data) => events.push({ type, data }),
      }),
      crawler: { crawl: async () => siteMap },
      planner: {
        plan: async () => [tc('a'), tc('b')],
        planFrom: async (_t, _s, screens, existing, round) => {
          plannedRounds.push(round);
          return screens.map((sc, i) =>
            tc(`r${round}-${i}`, { startsFrom: { ...sc.from, url: sc.url }, prefix: sc.steps }),
          );
        },
      },
      runner: {
        run: async (t) => result(t, 'pass', `${ORIGIN}/${t.id}`, `screen ${t.id}`),
      },
      reporter: { report: async () => undefined },
      deeper: rounds
        ? {
            rounds,
            discover: async (results) => {
              const n = screensPerRound[discovered++] ?? 0;
              return results.slice(0, n).map((r) => ({
                url: r.evidence.finalUrl,
                title: r.test.title,
                from: { testId: r.test.id, title: r.test.title },
                steps: STEPS,
                page: { url: r.evidence.finalUrl, title: '', links: [] },
              }));
            },
          }
        : undefined,
    });
    return { pipeline, events, plannedRounds, discoveries: () => discovered };
  }
  const initial = { runId: 'r', startedAt: '', target: { url: `${ORIGIN}/` }, tests: [] };

  it('runs one round by default, as before', async () => {
    const { pipeline, plannedRounds } = build({});
    const state = await pipeline.invoke(initial);
    expect(state.report?.results.map((r) => r.test.id)).toEqual(['a', 'b']);
    expect(plannedRounds).toEqual([]);
  });

  it('plans and runs round 2 from the screens round 1 reached, then reports everything in order', async () => {
    const { pipeline, events, plannedRounds } = build({ rounds: 2, screensPerRound: [2] });
    const state = await pipeline.invoke(initial);
    expect(plannedRounds).toEqual([2]);
    expect(state.report?.results.map((r) => r.test.id)).toEqual(['a', 'b', 'r2-0', 'r2-1']);
    expect(state.report?.results.slice(2).every((r) => r.test.round === 2)).toBe(true);
    const extended = events.find((e) => e.type === 'plan.extended');
    expect(extended?.data.tests.map((/** @type {any} */ t) => t.startsFrom.testId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('stops early when a round reaches no new screen, and never goes past the round budget', async () => {
    const none = build({ rounds: 3, screensPerRound: [0] });
    const s1 = await none.pipeline.invoke(initial);
    expect(s1.report?.results).toHaveLength(2);
    expect(none.plannedRounds).toEqual([]);

    const capped = build({ rounds: 3, screensPerRound: [1, 1, 1] });
    const s2 = await capped.pipeline.invoke(initial);
    expect(capped.plannedRounds).toEqual([2, 3]);
    expect(s2.report?.results.map((r) => r.test.id)).toEqual(['a', 'b', 'r2-0', 'r3-0']);
  });
});
