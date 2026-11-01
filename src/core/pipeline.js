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
 * @import { Screen } from './discovery.js'
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
  /** exploring deeper: the round now running (1 = tests from the crawl) and the tests it added */
  round: Annotation(),
  newTests: Annotation(),
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
 * @property {number} [round]
 * @property {TestCase[]} [newTests]
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
 * @property {() => import('../llm/promptCache.js').TokenUsage} [overheadUsage]  planner + judge tokens so far
 * @property {RunReport['auth']} [auth]  the login the run did first, if any
 * @property {{ rounds: number, discover: (results: TestResult[], siteMap: SiteMap) => Promise<Screen[]> }} [deeper]
 *   explore deeper: after each round, plan tests that start on the new screens its passing tests reached
 * @property {AbortSignal} [signal]  a stopped run plans no further round
 * @property {string} [suite]  the suite's name, written into the report
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
    cachedInputTokens: results.reduce((n, r) => n + (r.llmUsage?.cachedInputTokens ?? 0), 0),
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
 *   START -> crawl -> plan --(Send: one branch per test, `concurrency` at a time)--> runTest -> discover
 *                       \------------------------- no tests ---------------------------------> writeReport -> END
 *   discover --(more rounds and new screens: Send one branch per new test)--> runTest
 *   discover --(otherwise)--> writeReport
 *
 * With one round (the default) `discover` always goes straight to the report. With more (exploring deeper), it
 * takes the screens the round's passing tests ended on that the crawl never saw, and the planner plans tests that
 * start there; Playwright replays the steps that reach each screen, then the agent continues.
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
  // the next node (reproduced in this repo). Every branch starts, then waits for a slot.
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
      return { tests, round: 1, newTests: tests };
    })
    // One branch per test (fan-out via Send); each appends its result to `results`.
    .addNode('runTest', async (/** @type {{ test: TestCase }} */ input) => {
      const result = await slots.run(() => {
        logger.info(`Running: ${input.test.title}`);
        return runner.run(input.test);
      });
      return { results: [result] };
    })
    // After every round: plan the next one from the new screens its passing tests reached, or stop.
    .addNode('discover', async (/** @type {any} */ state) => {
      const s = /** @type {PipelineState} */ (state);
      const round = s.round ?? 1;
      const deeper = deps.deeper;
      if (!deeper || round >= deeper.rounds || !planner.planFrom || deps.signal?.aborted)
        return { newTests: [] };
      phase('deeper', 'running', `round ${round + 1}`);
      const ran = s.results.filter((r) => (r.test.round ?? 1) === round);
      const screens = await deeper.discover(ran, /** @type {SiteMap} */ (s.siteMap));
      if (!screens.length) {
        logger.info(`Exploring deeper: round ${round} reached no screen the crawl had not seen`);
        phase('deeper', 'done', 'no new screens');
        return { newTests: [] };
      }
      logger.info(
        `Exploring deeper: ${screens.length} new screen(s): ${screens.map((sc) => sc.url).join(', ')}`,
      );
      events.emit('screens.found', {
        round: round + 1,
        screens: screens.map((sc) => ({ url: sc.url, title: sc.title, from: sc.from })),
      });
      // tests the AI's reading blamed on how they were written get one rewrite from a deeper screen
      const retry = ran
        .filter((r) => r.verdict.status === 'fail' && r.explanation?.category === 'test-problem')
        .map((r) => ({
          title: r.test.title,
          goal: r.test.goal,
          reading: [r.explanation?.cause, r.explanation?.suggestion].filter(Boolean).join(' '),
        }));
      if (retry.length)
        logger.info(
          `Exploring deeper: asking the planner to rewrite ${retry.length} test(s) the AI's reading blamed on the test`,
        );
      const planned = await planner.planFrom(
        s.target,
        /** @type {SiteMap} */ (s.siteMap),
        screens,
        s.tests,
        round + 1,
        retry,
      );
      const newTests = planned.map((t) => ({ ...t, round: round + 1 }));
      events.emit('plan.extended', {
        round: round + 1,
        tests: newTests.map((t) => ({
          id: t.id,
          title: t.title,
          goal: t.goal,
          expectations: t.expectations,
          startsFrom: t.startsFrom,
          round: t.round,
        })),
      });
      phase('deeper', 'done', `${newTests.length} test(s) from ${screens.length} screen(s)`);
      return { tests: [...s.tests, ...newTests], newTests, round: round + 1 };
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
          agent: config.agentEngine === 'loop' ? `${config.model} (own loop)` : config.model,
          planner: config.plannerModel ?? config.model,
          judge: config.judgeModel ?? config.model,
          ...(config.preset ? { preset: config.preset } : {}),
        },
        ...(deps.auth ? { auth: deps.auth } : {}),
        ...(deps.signal?.aborted ? { stopped: true } : {}),
        ...(deps.suite ? { suite: deps.suite } : {}),
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
    .addEdge('runTest', 'discover')
    .addConditionalEdges(
      'discover',
      (/** @type {any} */ state) => {
        const s = /** @type {PipelineState} */ (state);
        return s.newTests?.length
          ? s.newTests.map((test) => new Send('runTest', { test }))
          : 'writeReport';
      },
      ['runTest', 'writeReport'],
    )
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
