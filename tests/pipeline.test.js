import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { buildPipeline } from '../src/core/pipeline.js';
import { silentLogger } from '../src/util/logger.js';

/** @param {string} id @returns {import('../src/core/types.js').TestCase} */
const tc = (id) => ({
  id,
  title: id,
  goal: '',
  startUrl: 'https://a.test/',
  expectations: [],
  tags: [],
});

/**
 * @param {{ tests: import('../src/core/types.js').TestCase[], concurrency?: number, delays?: Record<string, number> }} o
 */
function build({ tests, concurrency = 2, delays = {} }) {
  let running = 0;
  let peak = 0;
  /** @type {import('../src/core/types.js').RunReport[]} */
  const reports = [];
  const pipeline = buildPipeline({
    config: loadConfig({ concurrency, logLevel: 'silent' }, {}),
    logger: silentLogger,
    crawler: { crawl: async () => ({ origin: 'https://a.test', pages: [] }) },
    planner: { plan: async () => tests },
    runner: {
      run: async (t) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, delays[t.id] ?? 20));
        running--;
        return {
          test: t,
          mode: 'deterministic',
          verdict: {
            status: t.id.startsWith('bad') ? 'fail' : 'pass',
            reason: '',
            checks: [],
            warnings: [],
          },
          evidence: {
            finalUrl: '',
            title: '',
            pageTextExcerpt: '',
            screenshots: [],
            console: [],
            networkFailures: [],
          },
          claimMismatch: false,
          heals: [],
          durationMs: 1,
        };
      },
    },
    reporter: { report: async (r) => void reports.push(r) },
    overheadUsage: () => ({ inputTokens: 7, outputTokens: 3 }),
  });
  return { pipeline, reports, peak: () => peak };
}

const initial = {
  runId: 'r',
  startedAt: '2026-10-29T00:00:00Z',
  target: { url: 'https://a.test/' },
  tests: [],
};

describe('pipeline (LangGraph)', () => {
  it('fans out one branch per test, caps parallelism, and reports in plan order', async () => {
    const tests = ['a', 'bad-b', 'c', 'd', 'e'].map(tc);
    // the first test is the slowest, so branches finish out of order
    const { pipeline, reports, peak } = build({ tests, concurrency: 2, delays: { a: 120 } });
    const state = await pipeline.invoke(initial);
    expect(peak()).toBe(2);
    expect(state.report?.results.map((r) => r.test.id)).toEqual(['a', 'bad-b', 'c', 'd', 'e']);
    expect(state.report?.summary).toMatchObject({
      total: 5,
      passed: 4,
      failed: 1,
      overhead: { inputTokens: 7 },
    });
    expect(reports).toHaveLength(1);
  });

  it('runs strictly one at a time with concurrency 1 (LangGraph maxConcurrency=1 drops branches)', async () => {
    const tests = ['a', 'b', 'c'].map(tc);
    const { pipeline, peak } = build({ tests, concurrency: 1 });
    const state = await pipeline.invoke(initial);
    expect(peak()).toBe(1);
    expect(state.report?.results.map((r) => r.test.id)).toEqual(['a', 'b', 'c']);
  });

  it('goes straight to the report when the planner returns nothing', async () => {
    const { pipeline, reports } = build({ tests: [] });
    const state = await pipeline.invoke(initial);
    expect(state.report?.summary.total).toBe(0);
    expect(reports).toHaveLength(1);
  });

  it('exposes the compiled graph (its shape is part of the docs)', () => {
    const { pipeline } = build({ tests: [] });
    const mermaid = pipeline.graph.getGraph().drawMermaid();
    for (const node of ['crawl', 'plan', 'runTest', 'writeReport']) expect(mermaid).toContain(node);
  });
});
