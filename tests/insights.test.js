import { describe, expect, it } from 'vitest';
import { checkLabel, pageName, runInsights, testInsight } from '../src/reporter/insights.js';

/** @typedef {import('../src/core/types.js').TestResult} TestResult */

const base = 'https://shop.test';
/** @param {Partial<TestResult> & { id: string }} o @returns {TestResult} */
const result = ({ id, ...over }) => ({
  test: { id, title: id, goal: 'do it', startUrl: `${base}/`, expectations: [], tags: [] },
  mode: 'replay',
  verdict: { status: 'pass', reason: '', checks: [], warnings: [] },
  evidence: {
    finalUrl: `${base}/`,
    title: 'Shop',
    pageTextExcerpt: '',
    screenshots: [],
    console: [],
    networkFailures: [],
  },
  claimMismatch: false,
  heals: [],
  durationMs: 1000,
  ...over,
});
/** @param {TestResult[]} results @returns {import('../src/core/types.js').RunReport} */
const report = (results) => ({
  runId: 'r',
  startedAt: '2026-10-30T00:00:00Z',
  finishedAt: '2026-10-30T00:01:00Z',
  targetUrl: base,
  summary: {
    total: results.length,
    passed: results.filter((r) => r.verdict.status === 'pass').length,
    failed: results.filter((r) => r.verdict.status === 'fail').length,
    errored: results.filter((r) => r.verdict.status === 'error').length,
    healed: 0,
    claimMismatches: 0,
    inputTokens: 0,
    outputTokens: 0,
  },
  results,
});
/** @param {number} i @param {string} url @param {string} description @param {boolean} [ok] */
const step = (i, url, description, ok = true) => ({
  index: i,
  source: /** @type {const} */ ('replay'),
  tool: 'click',
  description,
  ok,
  url: `${base}${url}`,
  screenshot: `t/${i}.png`,
  ts: '',
});

/** A checkout that gets stuck on the form, the way Sauce Demo's problem_user does. */
const stuckCheckout = (/** @type {string} */ id, /** @type {string} */ target) =>
  result({
    id,
    trace: [
      step(0, '/cart', 'Open the cart'),
      step(1, '/checkout', 'Type the last name'),
      step(2, '/checkout', 'Click Finish', false),
    ],
    verdict: {
      status: 'fail',
      reason: 'Step 3 failed',
      warnings: [],
      checks: [
        {
          expectation: { kind: 'url', pattern: target, mode: 'includes' },
          passed: false,
          detail: 'URL does not match',
        },
        {
          expectation: {
            kind: 'text-visible',
            text: 'Thank you',
            label: 'The thank-you message appears',
          },
          passed: false,
          detail: 'not visible',
        },
        { expectation: { kind: 'no-console-errors' }, passed: true, detail: 'ok' },
      ],
    },
    evidence: {
      ...result({ id }).evidence,
      finalUrl: `${base}/checkout?step=1`,
      pageTextExcerpt: 'Swag\nCheckout: Your Information\nError: Last Name is required\nCancel',
    },
  });

describe('insights', () => {
  it('names pages the way people do', () => {
    expect(pageName(`${base}/checkout-step-one.html`)).toBe('Checkout step one');
    expect(pageName(`${base}/`)).toBe('Home');
    expect(pageName(`${base}/#/active`)).toBe('Active');
    expect(pageName(`${base}/deck/8f3a2b1c-9d`)).toBe('Deck (one item)');
    expect(pageName('/cart.html')).toBe('Cart');
  });

  it('says checks in words, preferring the label', () => {
    expect(
      checkLabel({ kind: 'text-visible', text: 'Order placed', label: 'The order is placed' }),
    ).toBe('The order is placed');
    expect(checkLabel({ kind: 'url', pattern: '/checkout-complete.html', mode: 'includes' })).toBe(
      'The “Checkout complete” page opens',
    );
    expect(
      checkLabel({
        kind: 'selector-visible',
        selector: "xpath=//img[@alt='Backpack' and contains(@src,'b')]",
      }),
    ).toBe('The Backpack image is shown');
    expect(
      checkLabel({
        kind: 'selector-visible',
        selector: "xpath=//div[@data-test='cart-list'][count(.//div[@data-test='item'])=2]",
      }),
    ).toBe('The cart list holds 2 items');
    expect(checkLabel({ kind: 'selector-visible', selector: '[data-testid="cart-badge"]' })).toBe(
      'The cart badge is shown',
    );
  });

  it('turns a stuck flow into pages, a stuck node, an unreached page and the page’s own error', () => {
    const t = testInsight(stuckCheckout('order', '/done'));
    expect(t.pages.map((p) => [p.name, p.status])).toEqual([
      ['Cart', 'ok'],
      ['Checkout', 'stuck'],
      ['Done', 'unreached'],
    ]);
    expect(t.failedStep?.description).toBe('Click Finish');
    expect(t.pageMessage).toBe('Error: Last Name is required');
    expect(t.outcome).toBe('Stuck on “Checkout”: “Error: Last Name is required”');
    expect(t.reasons[1]).toMatchObject({
      expected: 'The thank-you message appears',
      actual: '“Thank you” was not on the final page',
    });
    expect(t.how).toBe('Replay · 3 steps');
  });

  it('groups tests stuck on the same page into one high-severity finding', () => {
    const r = report([
      stuckCheckout('order', '/done'),
      stuckCheckout('total', '/overview'),
      result({ id: 'browse', verdict: { status: 'pass', reason: '', warnings: [], checks: [] } }),
    ]);
    const i = runInsights(r);
    const stuck = i.findings.filter((f) => f.title.includes('stuck'));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({
      severity: 'high',
      title: '2 flows get stuck on “Checkout”',
      testIds: ['order', 'total'],
    });
    expect(stuck[0].detail).toContain('“Error: Last Name is required”');
    expect(stuck[0].detail).toContain('“Click Finish” could not be done');
    expect(i.headline).toBe('1 problem found');
    expect(i.sentence).toMatch(/^1 of 3 flows work\. Failing: “order”, “total”\.$/);
    expect(i.tone).toBe('bad');
  });

  it('reports a wrong result as Expected / instead, and console errors in plain words', () => {
    const r = report([
      result({
        id: 'remove',
        evidence: {
          ...result({ id: 'x' }).evidence,
          finalUrl: `${base}/cart`,
          console: [
            { type: 'error', text: 'Minified React error #418; visit https://react.dev', ts: '' },
          ],
        },
        verdict: {
          status: 'fail',
          reason: '',
          warnings: [],
          checks: [
            {
              expectation: {
                kind: 'selector-visible',
                selector: '#n',
                label: 'The cart holds 1 product',
              },
              passed: false,
              detail: 'not visible',
            },
            {
              expectation: { kind: 'no-console-errors' },
              passed: false,
              detail: '1 console error',
            },
          ],
        },
      }),
    ]);
    const i = runInsights(r);
    expect(i.findings.map((f) => [f.severity, f.category, f.title])).toEqual([
      ['medium', 'functional', 'Expected: the cart holds 1 product'],
      ['medium', 'errors', 'The app reports an error'],
    ]);
    expect(i.findings[1].detail).toMatch(/hydration/);
    expect(i.tests.remove.outcome).toBe('Not as expected: the cart holds 1 product');
  });

  it('keeps visual changes, AI disagreements and heals visible as things to review', () => {
    const changed = result({
      id: 'look',
      mode: 'healed',
      heals: [
        { testId: 'look', stepIndex: 1, description: 'Buy', reason: 'gone', outcome: 'healed' },
      ],
      evidence: {
        ...result({ id: 'x' }).evidence,
        visual: {
          captures: [],
          results: [
            {
              checkpoint: 'final',
              label: 'final',
              status: 'changed',
              current: 'a.png',
              diff: 'a.diff.png',
              diffRatio: 0.12,
            },
            { checkpoint: 's1', label: 'after step 1', status: 'unchanged', current: 'b.png' },
          ],
        },
      },
    });
    const lied = result({
      id: 'claim',
      agentClaim: { success: true, message: 'done' },
      claimMismatch: true,
      verdict: {
        status: 'fail',
        reason: 'Inconclusive: every outcome expectation was already true',
        warnings: [],
        checks: [],
      },
    });
    const i = runInsights(report([changed, lied]));
    const kinds = i.findings.map((f) => `${f.severity}/${f.category}`);
    expect(kinds).toEqual([
      'medium/functional',
      'review/agent',
      'review/visual',
      'low/maintenance',
    ]);
    expect(i.findings.find((f) => f.category === 'visual')).toMatchObject({
      title: '1 screen looks different from the approved version',
      image: 'a.diff.png',
    });
    expect(i.kpis.visual).toMatchObject({ minPct: 12, maxPct: 12 });
    expect(i.tests.claim.outcome).toBe('Nothing showed the goal was reached');
  });

  it('says all flows work when they do, and names the best proof per test', () => {
    const ok = result({
      id: 'add',
      verdict: {
        status: 'pass',
        reason: '',
        warnings: [],
        checks: [
          {
            expectation: { kind: 'text-visible', text: 'Shop' },
            passed: true,
            vacuous: true,
            detail: '',
          },
          {
            expectation: { kind: 'selector-visible', selector: '#b', label: 'The cart shows 2' },
            passed: true,
            detail: '',
          },
          { expectation: { kind: 'no-console-errors' }, passed: true, detail: '' },
        ],
      },
    });
    const i = runInsights({
      ...report([ok]),
      auth: { loginUrl: '/', username: 'standard_user', landedOn: '/' },
    });
    expect(i.headline).toBe('The flow works');
    expect(i.sentence).toContain('for standard_user');
    expect(i.tone).toBe('ok');
    expect(i.findings).toEqual([]);
    expect(i.tests.add.outcome).toBe('The cart shows 2');
  });

  it('explains the console error the judge counted, including uncaught page errors', () => {
    const t = testInsight(
      result({
        id: 'crash',
        evidence: {
          ...result({ id: 'x' }).evidence,
          console: [
            {
              type: 'pageerror',
              text: 'Minified React error #425; visit https://react.dev',
              ts: '',
            },
          ],
        },
        verdict: {
          status: 'fail',
          reason: '',
          warnings: [],
          checks: [
            {
              expectation: { kind: 'no-console-errors' },
              passed: false,
              detail: '8 console error(s): Minified React error #425; visit https://react.dev',
            },
          ],
        },
      }),
    );
    expect(t.reasons[0].actual).toMatch(
      /^8 errors in the console, first: React error #425: text rendered/,
    );
  });

  it('tells a flow that reached its goal but hit app errors apart from a broken flow', () => {
    const r = result({
      id: 'tagging',
      agentClaim: { success: true, message: 'Opened the tagging page' },
      claimMismatch: true,
      evidence: { ...result({ id: 'x' }).evidence, finalUrl: `${base}/tagging` },
      verdict: {
        status: 'fail',
        reason: '',
        warnings: [],
        checks: [
          {
            expectation: {
              kind: 'url',
              pattern: '/tagging',
              mode: 'includes',
              label: 'The tagging page opens',
            },
            passed: true,
            detail: '',
          },
          {
            expectation: { kind: 'no-console-errors' },
            passed: false,
            detail: '8 console error(s): Minified React error #425',
          },
        ],
      },
    });
    const i = runInsights(report([r]));
    expect(i.tests.tagging.outcome).toMatch(/^Goal reached, but 8 errors in the console/);
    expect(i.sentence).toBe(
      '0 of 1 flow work. 1 more reaches its goal but fails because the app logs errors or requests fail.',
    );
    // the agent was right about the goal: not an AI-honesty finding
    expect(i.findings.some((f) => f.category === 'agent')).toBe(false);
  });

  it('reports a failing request once, as the cause of the flows it breaks', () => {
    const broken = (/** @type {string} */ id) =>
      result({
        id,
        agentClaim: { success: true, message: 'done' },
        claimMismatch: true,
        verdict: {
          status: 'fail',
          reason: '',
          warnings: [],
          checks: [
            { expectation: { kind: 'visual', question: 'Is it open?' }, passed: true, detail: '' },
            {
              expectation: { kind: 'no-console-errors' },
              passed: false,
              detail:
                '1 console error(s): Failed to load resource: the server responded with a status of 502 ()',
            },
            {
              expectation: { kind: 'no-network-failures' },
              passed: false,
              detail: '1 failed request(s): 502 https://shop.test/api/describe',
            },
          ],
        },
        evidence: {
          ...result({ id: 'x' }).evidence,
          networkFailures: [{ url: `${base}/api/describe`, method: 'POST', status: 502, ts: '' }],
        },
      });
    const wrong = result({
      id: 'blank',
      explanation: {
        cause: 'The app makes an empty deck by design',
        category: 'test-problem',
        confidence: 'high',
        evidence: [],
        suggestion: 'Check for "No slides yet"',
        model: 'judge',
      },
      agentClaim: { success: true, message: 'done' },
      claimMismatch: true,
      verdict: {
        status: 'fail',
        reason: '',
        warnings: [],
        checks: [
          {
            expectation: {
              kind: 'visual',
              question: 'Is a blank slide shown?',
              label: 'A blank slide is shown',
            },
            passed: false,
            detail: 'no',
          },
        ],
      },
    });
    const i = runInsights(report([broken('a'), broken('b'), wrong]));
    const errors = i.findings.filter((f) => f.category === 'errors');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      severity: 'high',
      title: 'A server request fails and breaks 2 flows that otherwise work',
      testIds: ['a', 'b'],
    });
    // the AI's reading says the test was wrong: something to review, and not an AI-honesty case
    expect(i.findings.find((f) => f.testIds?.includes('blank'))?.severity).toBe('review');
    expect(i.findings.some((f) => f.category === 'agent')).toBe(false);
  });
});
