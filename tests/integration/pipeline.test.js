import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BfsCrawler } from '../../src/crawler/bfsCrawler.js';
import { NoopCrawler } from '../../src/crawler/noopCrawler.js';
import { LlmPlanner } from '../../src/planner/llmPlanner.js';
import { StaticPlanner } from '../../src/planner/staticPlanner.js';
import { silentLogger } from '../../src/util/logger.js';
import { mockLlm } from '../helpers.js';
import { hasChromium, runPipeline, startApp, testConfig } from './harness.js';

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let app;
beforeAll(async () => {
  app = /** @type {typeof app} */ (await startApp());
});
afterAll(() => app?.server.close());

/**
 * @param {string} id
 * @param {string} url
 * @param {import('../../src/core/types.js').Expectation[]} [expectations]
 * @returns {import('../../src/core/types.js').TestCase}
 */
const smokeTest = (id, url, expectations = []) => ({
  id,
  title: `Smoke ${id}`,
  goal: '',
  startUrl: url,
  expectations: [...expectations, { kind: 'no-console-errors' }, { kind: 'no-network-failures' }],
  tags: [],
});

describe.skipIf(!hasChromium)('strict judge (real browser, no LLM)', () => {
  it('passes a healthy page, writes JSON + HTML reports and screenshot evidence', async () => {
    const { report, artifacts } = await runPipeline({
      planner: new StaticPlanner(),
      crawler: new NoopCrawler(),
      url: app.base,
    });
    const r = report.results[0];
    expect(r?.verdict.status, r?.verdict.reason).toBe('pass');
    expect(r?.mode).toBe('deterministic');
    expect(r?.evidence.title).toBe('Home');
    const shot = r?.evidence.screenshots[0]?.path ?? '';
    expect(existsSync(path.join(artifacts.runDir, shot))).toBe(true);
    expect(existsSync(path.join(artifacts.runDir, 'report.json'))).toBe(true);
    expect(readFileSync(path.join(artifacts.runDir, 'report.html'), 'utf8')).toContain(
      'Smoke: page loads without errors',
    );
  });

  it('fails a page with console errors and failed requests', async () => {
    const { report } = await runPipeline({
      planner: new StaticPlanner(),
      crawler: new NoopCrawler(),
      url: `${app.base}/broken`,
    });
    const r = report.results[0];
    expect(r?.verdict.status).toBe('fail');
    expect(r?.verdict.checks.filter((c) => !c.passed).map((c) => c.expectation.kind)).toEqual(
      expect.arrayContaining(['no-console-errors', 'no-network-failures']),
    );
  });
});

describe.skipIf(!hasChromium)('parallel runs', () => {
  it('runs tests concurrently in isolated browsers', async () => {
    const planner = {
      plan: async () => [
        smokeTest('home', app.base, [{ kind: 'text-visible', text: 'Welcome home' }]),
        smokeTest('about', `${app.base}/about`, [{ kind: 'text-visible', text: 'About our team' }]),
        smokeTest('absent', `${app.base}/about`, [{ kind: 'text-visible', text: 'Nope nope' }]),
      ],
    };
    const t0 = Date.now();
    const { report, artifacts } = await runPipeline({
      planner,
      crawler: new NoopCrawler(),
      url: app.base,
      concurrency: 3,
    });
    expect(report.results.map((r) => r.verdict.status)).toEqual(['pass', 'pass', 'fail']);
    expect(report.summary).toMatchObject({ total: 3, passed: 2, failed: 1 });
    for (const id of ['home', 'about', 'absent']) {
      expect(existsSync(path.join(artifacts.runDir, id, 'screenshots'))).toBe(true);
    }
    expect(Date.now() - t0).toBeLessThan(60_000);
  });
});

describe.skipIf(!hasChromium)('crawler', () => {
  it('maps same-origin pages and never visits logout/delete/external/asset links', async () => {
    const crawler = new BfsCrawler(testConfig(), silentLogger);
    const map = await crawler.crawl({ url: app.base });
    const urls = map.pages.map((p) => new URL(p.url).pathname).sort();
    expect(urls).toEqual(['/', '/about', '/products']);
    const home = map.pages.find((p) => new URL(p.url).pathname === '/');
    expect(home?.title).toBe('Home');
    expect(home?.forms).toBe(1);
    expect(app.hits).not.toContain('/logout');
    expect(app.hits).not.toContain('/delete-account');
    expect(app.hits).not.toContain('/file.pdf');
  });

  it('respects maxPages', async () => {
    const cfg = testConfig({ crawl: { maxPages: 1, maxDepth: 2 } });
    const map = await new BfsCrawler(cfg, silentLogger).crawl({ url: app.base });
    expect(map.pages).toHaveLength(1);
  });
});

describe.skipIf(!hasChromium)('AI planning end to end (mock LLM, real browser)', () => {
  const plan = {
    tests: [
      {
        title: 'Open the about page',
        goal: '', // empty goal keeps this deterministic: no agent/LLM browser driving in tests
        expectations: [{ kind: 'text-visible', value: 'Welcome home' }],
      },
    ],
  };

  it('crawls, plans from the crawl, runs and reports', async () => {
    const spy = { calls: /** @type {unknown[]} */ ([]) };
    const llm = mockLlm(plan, spy);
    const { report } = await runPipeline({
      crawler: new BfsCrawler(testConfig(), silentLogger),
      planner: new LlmPlanner(llm, { maxTests: 3 }, silentLogger),
      url: app.base,
    });
    expect(report.results.map((r) => r.test.id)).toEqual(['smoke', 'open-the-about-page']);
    expect(report.results.every((r) => r.verdict.status === 'pass')).toBe(true);
    // The planner prompt contained what the crawler found.
    const prompt = JSON.stringify(spy.calls[0]);
    expect(prompt).toContain('About us');
    expect(prompt).not.toContain('/logout');
  });
});

describe.skipIf(!hasChromium)('visual expectations', () => {
  /** @param {boolean} answer */
  const run = (answer) =>
    runPipeline({
      planner: {
        plan: async () => [
          smokeTest('visual', app.base, [
            { kind: 'visual', question: 'Is a welcome heading visible?' },
          ]),
        ],
      },
      crawler: new NoopCrawler(),
      url: app.base,
      llm: mockLlm({ answer, reasoning: 'Heading reads "Welcome home".' }),
    });

  it('passes when the LLM confirms from the harness screenshot', async () => {
    const { report } = await run(true);
    expect(report.results[0]?.verdict.status).toBe('pass');
    expect(report.results[0]?.verdict.checks[0]?.detail).toContain('Welcome home');
  });

  it('fails when the LLM says no', async () => {
    const { report } = await run(false);
    expect(report.results[0]?.verdict.status).toBe('fail');
  });

  it('fails (not silently passes) when no LLM is configured', async () => {
    const { report } = await runPipeline({
      planner: {
        plan: async () => [
          smokeTest('visual', app.base, [{ kind: 'visual', question: 'Anything?' }]),
        ],
      },
      crawler: new NoopCrawler(),
      url: app.base,
    });
    expect(report.results[0]?.verdict.status).toBe('fail');
    expect(report.results[0]?.verdict.reason).toContain('no LLM configured');
  });
});
