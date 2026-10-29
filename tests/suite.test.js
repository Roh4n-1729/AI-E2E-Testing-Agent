import { describe, expect, it } from 'vitest';
import {
  SeededRecordStore,
  SuitePlanner,
  SuiteSchema,
  suiteFromRun,
} from '../src/planner/suitePlanner.js';
import { testFingerprint } from '../src/storage/recordStore.js';

const suite = SuiteSchema.parse({
  description: 'shop',
  tests: [
    { title: 'Home loads' },
    {
      title: 'Cart total',
      goal: 'Add a mug and open the cart',
      startUrl: '/shop',
      expectations: [{ kind: 'text-visible', text: '₹598' }],
      steps: [{ kind: 'act', description: 'Add', selector: '#add', method: 'click' }],
    },
    { title: 'Cart total', goal: 'Same title, no steps' },
  ],
});

describe('committed test suites', () => {
  it('resolves relative URLs, adds the guard checks, de-duplicates ids and seeds recordings', async () => {
    const planner = new SuitePlanner(suite);
    const tests = await planner.plan(
      { url: 'https://staging.shop.test/app/' },
      { origin: '', pages: [] },
    );
    expect(tests.map((t) => t.id)).toEqual(['home-loads', 'cart-total', 'cart-total-2']);
    expect(tests[1]?.startUrl).toBe('https://staging.shop.test/shop');
    expect(tests[1]?.expectations.map((e) => e.kind)).toEqual([
      'text-visible',
      'no-console-errors',
      'no-network-failures',
    ]);

    const seed = planner.seeds.get('cart-total');
    expect(seed?.fingerprint).toBe(testFingerprint(/** @type {any} */ (tests[1])));
    expect(seed?.steps.map((s) => [s.index, s.kind])).toEqual([
      [0, 'navigate'],
      [1, 'act'],
    ]);
    expect(planner.seeds.has('cart-total-2')).toBe(false); // no steps: the agent does it

    // a saved recording (e.g. after a heal) wins over the suite's own steps
    const saved = { ...seed, recordedAt: 'later' };
    const store = new SeededRecordStore(
      {
        load: async (id) => (id === 'cart-total' ? /** @type {any} */ (saved) : null),
        save: async () => {},
      },
      planner.seeds,
    );
    expect((await store.load('cart-total'))?.recordedAt).toBe('later');
    expect(await store.load('nope')).toBeNull();
  });

  it('exports a finished run back into a suite with relative URLs and recorded steps', async () => {
    const planner = new SuitePlanner(suite);
    const tests = await planner.plan({ url: 'https://shop.test/' }, { origin: '', pages: [] });
    const report = /** @type {any} */ ({
      targetUrl: 'https://shop.test/',
      results: tests.map((test) => ({ test })),
    });
    const out = await suiteFromRun(report, async (id) => planner.seeds.get(id) ?? null);
    expect(out.tests[1]).toMatchObject({
      startUrl: '/shop',
      expectations: [{ kind: 'text-visible', text: '₹598' }],
      steps: [{ kind: 'act', selector: '#add' }],
    });
    expect(SuiteSchema.safeParse(out).success).toBe(true);
  });
});
