import { Annotation, END, START, Send, StateGraph } from '@langchain/langgraph';
import { nullEvents } from '../events/runEvents.js';
import { createLimiter } from '../util/misc.js';
import { analyseConsistency } from '../theme/consistency.js';

/**
 * @import { Config } from '../config/config.js'
 * @import { Logger } from '../util/logger.js'
 * @import { Crawler, Planner, Reporter } from './ports.js'
 * @import { TestRunner } from './testRunner.js'
 * @import { RunReport, RunSummary, SiteMap, Target, TestCase, TestResult } from './types.js'
 */

/**
 * Graph state. Every channel is last-write-wins except `results`, which the parallel per-test
 * branches append to (LangGraph merges their writes with the reducer).
 */
const PipelineState = Annotation.Root({
  runId: Annotation(),
  startedAt: Annotation(),
  target: Annotation(),
  siteMap: Annotation(),
  tests: Annotation(),
  results: Annotation({
    reducer: (/** @type {TestResult[]} */ a, /** @type {TestResult[]} */ b) => a.concat(b),
    default: () => [],
  }),
  report: Annotation(),
});

/**
 * @typedef {object} PipelineState
 * @property {string} runId
 * @property {string} startedAt
 * @property {Target} target
 * @property {SiteMap} [siteMap]
 * @property {TestCase[]} tests
 * @property {TestResult[]} results
 * @property {RunReport} [report]
 */

/**
 * @typedef {object} PipelineDeps
 * @property {Config} config
 * @property {Crawler} crawler
 * @property {Planner} planner
 * @property {Pick<TestRunner, 'run'>} runner
 * @property {Reporter} reporter
 * @property {Logger} logger
 * @property {import('../events/runEvents.js').RunEvents} [events]
 * @property {() => { inputTokens: number, outputTokens: number }} [overheadUsage]  planner + judge tokens so far
 * @property {RunReport['auth']} [auth]  the login the run did first, if any
 */

/** @param {TestResult[]} results @returns {RunSummary} */
export function summarize(results) {
  return {
    total: results.length,
    passed: results.filter((r) => r.verdict.status === 'pass').length,
    failed: results.filter((r) => r.verdict.status === 'fail').length,
    errored: results.filter((r) => r.verdict.status === 'error').length,
    healed: results.filter((r) => r.mode === 'healed' && r.verdict.status === 'pass').length,
    claimMismatches: results.filter((r) => r.claimMismatch).length,
    inputTokens: results.reduce((n, r) => n + (r.llmUsage?.inputTokens ?? 0), 0),
    outputTokens: results.reduce((n, r) => n + (r.llmUsage?.outputTokens ?? 0), 0),
    visualChanges: results.filter((r) =>
      r.evidence.visual?.results?.some((v) => v.status === 'changed' || v.status === 'size'),
    ).length,
    visualNew: results.reduce(
      (n, r) => n + (r.evidence.visual?.results?.filter((v) => v.saved).length ?? 0),
      0,
    ),
  };
}

/**
 * The run as a LangGraph state graph:
 *
 *   START -> crawl -> plan --(Send: one branch per test, `concurrency` at a time)--> runTest -> writeReport -> END
 *                       \------------------------- no tests ----------------------------/
 *
 * Nodes stay plain async functions over the ports (crawler, planner, runner, reporter), so the
 * orchestration framework is swappable and every node is testable on its own. Progress for the UI
 * goes through our own event bus, not graph internals.
 * @param {PipelineDeps} deps
 */
export function buildPipeline(deps) {
  const { config, crawler, planner, runner, reporter, logger } = deps;
  const events = deps.events ?? nullEvents;
  /** @param {string} phase @param {'running' | 'done'} status @param {string} [detail] */
  const phase = (phase, status, detail) => events.emit('phase', { phase, status, detail });
  // Parallelism is capped HERE, not with LangGraph's `maxConcurrency`: in @langchain/langgraph 1.5.3
  // `maxConcurrency: 1` with a Send fan-out silently drops the branches' writes and never reaches
  // the next node (reproduced; see docs/IMPROVEMENTS.md). Every branch starts, then waits for a slot.
  const slots = createLimiter(config.concurrency);

  const graph = new StateGraph(PipelineState)
    .addNode('crawl', async (/** @type {any} */ state) => {
      const s = /** @type {PipelineState} */ (state);
      logger.info(`Crawling ${s.target.url}`);
      phase('crawl', 'running');
      const siteMap = await crawler.crawl(s.target);
      events.emit('site.ready', {
        pages: siteMap.pages.slice(0, 40).map((p) => ({ url: p.url, title: p.title })),
      });
      phase('crawl', 'done', `${siteMap.pages.length} page(s)`);
      return { siteMap };
    })
    .addNode('plan', async (/** @type {any} */ state) => {
      const s = /** @type {PipelineState} */ (state);
      phase('plan', 'running');
      const tests = await planner.plan(s.target, /** @type {SiteMap} */ (s.siteMap));
      logger.info(`Planned ${tests.length} test(s)`);
      events.emit('plan.ready', {
        tests: tests.map((t) => ({
          id: t.id,
          title: t.title,
          goal: t.goal,
          expectations: t.expectations,
        })),
      });
      phase('plan', 'done', `${tests.length} test(s)`);
      if (tests.length) phase('run', 'running');
      return { tests };
    })
    // One branch per test (fan-out via Send); each appends its result to `results`.
    .addNode('runTest', async (/** @type {{ test: TestCase }} */ input) => {
      const result = await slots.run(() => {
        logger.info(`Running: ${input.test.title}`);
        return runner.run(input.test);
      });
      return { results: [result] };
    })
    .addNode('writeReport', async (/** @type {any} */ state) => {
      const s = /** @type {PipelineState} */ (state);
      if (s.tests.length) phase('run', 'done');
      // branches finish in any order: report in plan order
      const order = new Map(s.tests.map((t, i) => [t.id, i]));
      const results = [...s.results].sort(
        (a, b) => (order.get(a.test.id) ?? 0) - (order.get(b.test.id) ?? 0),
      );
      /** @type {RunReport} */
      const report = {
        runId: s.runId,
        startedAt: s.startedAt,
        finishedAt: new Date().toISOString(),
        targetUrl: s.target.url,
        summary: { ...summarize(results), overhead: deps.overheadUsage?.() },
        results,
        models: {
          agent: config.model,
          planner: config.plannerModel ?? config.model,
          judge: config.judgeModel ?? config.model,
          ...(config.preset ? { preset: config.preset } : {}),
        },
        ...(deps.auth ? { auth: deps.auth } : {}),
      };
      if (results.some((r) => r.evidence.themeStates?.length)) {
        report.consistency = analyseConsistency(results);
        const n = report.consistency.findings.length;
        if (n) logger.warn(`Consistency: ${n} component look(s) drift across screens (advisory)`);
      }
      phase('report', 'running');
      await reporter.report(report);
      phase('report', 'done');
      return { report }; // `results` stays as the branches wrote it (its reducer appends)
    })
    .addEdge(START, 'crawl')
    .addEdge('crawl', 'plan')
    .addConditionalEdges(
      'plan',
      (/** @type {any} */ state) => {
        const s = /** @type {PipelineState} */ (state);
        return s.tests.length
          ? s.tests.map((test) => new Send('runTest', { test }))
          : 'writeReport';
      },
      ['runTest', 'writeReport'],
    )
    .addEdge('runTest', 'writeReport')
    .addEdge('writeReport', END)
    .compile();

  return {
    /** The compiled LangGraph graph (e.g. for `getGraph().drawMermaid()`). */
    graph,
    /**
     * @param {Omit<PipelineState, 'results'> & { results?: TestResult[] }} initial
     * @returns {Promise<PipelineState>}
     */
    async invoke(initial) {
      const input = { ...initial };
      delete input.results; // owned by the graph's reducer
      return /** @type {Promise<PipelineState>} */ (graph.invoke(input, { recursionLimit: 50 }));
    },
  };
}
