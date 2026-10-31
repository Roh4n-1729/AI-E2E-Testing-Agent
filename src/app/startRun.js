import path from 'node:path';
import { agentModelWarning, apiKeyEnvFor, loadConfig } from '../config/config.js';
import { BfsCrawler } from '../crawler/bfsCrawler.js';
import { NoopCrawler } from '../crawler/noopCrawler.js';
import { buildPipeline } from '../core/pipeline.js';
import { TestRunner } from '../core/testRunner.js';
import { RunEvents } from '../events/runEvents.js';
import { AgentExecutor } from '../executor/agentExecutor.js';
import { LoopAgentExecutor } from '../executor/loopAgentExecutor.js';
import { CachingExecutor } from '../executor/cachingExecutor.js';
import { ReplayExecutor } from '../executor/replayExecutor.js';
import { EvidenceJudge } from '../judge/evidenceJudge.js';
import { AiSdkLlm } from '../llm/aiSdkLlm.js';
import { CachedPlanner } from '../planner/cachedPlanner.js';
import { LlmPlanner, PLANNER_VERSION } from '../planner/llmPlanner.js';
import { StaticPlanner } from '../planner/staticPlanner.js';
import { SeededRecordStore, SuitePlanner, loadSuite } from '../planner/suitePlanner.js';
import { CompositeReporter } from '../reporter/compositeReporter.js';
import { HtmlReporter } from '../reporter/htmlReporter.js';
import { JsonReporter } from '../reporter/jsonReporter.js';
import { RunArtifacts } from '../storage/artifacts.js';
import { FileRecordStore } from '../storage/recordStore.js';
import { createLogger } from '../util/logger.js';
import { newRunId } from '../util/misc.js';
import { ThemeStates } from '../theme/states.js';
import { BaselineStore } from '../visual/baselines.js';
import { AuthSchema, performLogin } from '../auth/login.js';
import { FailureExplainer } from '../judge/failureExplainer.js';
import { captureReference } from '../theme/reference.js';

/**
 * @typedef {object} RunOptions  Everything a run needs; the CLI and the UI server both build this.
 * @property {string} url
 * @property {string} [description]
 * @property {string} [goal]               test exactly this flow (skips the AI planner)
 * @property {string} [expectUrl]
 * @property {string[]} [expectText]
 * @property {string} [model]
 * @property {'economy' | 'balanced' | 'best'} [preset]  models by role (explicit models win)
 * @property {'stagehand' | 'loop'} [agentEngine]  who drives the browser (default from AIE2E_AGENT_ENGINE)
 * @property {boolean} [headed]            show a real browser window
 * @property {number} [maxSteps]
 * @property {number} [maxTests]
 * @property {number} [maxPages]
 * @property {number} [concurrency]
 * @property {string} [outDir]
 * @property {boolean} [verbose]
 * @property {boolean} [plan]              false = no AI planner (smoke test only)
 * @property {boolean} [crawl]             false = skip crawling
 * @property {boolean} [cache]             false = always use the agent (no replay, no recording)
 * @property {boolean} [rerecord]
 * @property {boolean} [replan]
 * @property {string} [suite]            path to a committed test suite (JSON); replaces planning
 * @property {string} [suiteName]        the UI's name for that suite (shown, and used by "Run again")
 * @property {import('../auth/login.js').Auth} [auth]  log in first (a suite's own "auth" is used otherwise)
 * @property {string} [themeFrom]  check the theme against this other product's themes (a suite's own "themeFrom" otherwise)
 * @property {boolean} [heal]             false = a broken replay is a plain failure, never handed to the agent
 * @property {boolean} [explain]          false = no AI reading of failures (default: on when the judge's key is set)
 * @property {'off' | 'warn' | 'fail'} [quality]  Web Vitals / accessibility gate (default: warn = advisory)
 * @property {'off' | 'warn' | 'fail'} [visual]  screenshot comparison with approved baselines (default: warn)
 * @property {boolean} [updateBaselines]  accept every screenshot of a passing test as its new baseline
 * @property {boolean} [freezeBaselines]  never save new baselines in this run (the evaluation's seeded-bug runs)
 * @property {string} [runId]              pre-generated id (the server needs it before the run starts)
 */

/**
 * Whether this run will call an LLM, and which API key variable it then needs.
 * Lets callers fail fast with a clear message instead of halfway through a run.
 * @param {RunOptions} o
 */
export function llmRequirement(o) {
  const model = o.model ?? loadConfig({ preset: o.preset }).model;
  // The AI planner needs a model; so does an agent run for an explicit goal.
  // A suite may run entirely from its recorded steps; if a test needs the agent, that test reports it.
  const needed = o.suite ? false : (!o.goal && o.plan !== false) || !!o.goal;
  const keyVar = apiKeyEnvFor(model);
  return { needed, model, keyVar, keyPresent: keyVar ? !!process.env[keyVar] : true };
}

/**
 * Run the whole pipeline once. Shared by the CLI and the UI server.
 * @param {RunOptions} o
 * @param {{ events?: RunEvents, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ runId: string, report: import('../core/types.js').RunReport }>}
 */
export async function startRun(o, { events = new RunEvents(), signal } = {}) {
  const config = loadConfig({
    model: o.model,
    preset: o.preset,
    agentEngine: o.agentEngine,
    headless: o.headed ? false : undefined,
    maxSteps: o.maxSteps,
    maxTests: o.maxTests,
    concurrency: o.concurrency,
    outDir: o.outDir,
    logLevel: o.verbose ? 'debug' : undefined,
    crawl: o.maxPages ? { maxPages: o.maxPages, maxDepth: 2 } : undefined,
    quality: o.quality ? { gate: o.quality } : undefined,
    visual:
      o.visual || o.updateBaselines || o.freezeBaselines
        ? {
            gate: o.visual,
            update: o.updateBaselines || undefined,
            saveNew: o.freezeBaselines ? false : undefined,
          }
        : undefined,
  });
  const logger = createLogger(config.logLevel, '', (e) =>
    events.emit('log', { level: e.level, scope: e.scope, message: e.message }),
  );
  const agentWarning = agentModelWarning(config.model, config.agentEngine);
  if (agentWarning) logger.warn(agentWarning);
  /** "anthropic/claude-haiku-4-5" -> "claude-haiku-4-5" @param {string} m */
  const short = (m) => m.replace(/^[a-z]+\//, '');
  logger.info(
    `Models${config.preset ? ` (${config.preset})` : ''}: agent ${short(config.model)}${config.agentEngine === 'loop' ? ' (own loop)' : ''}, planner ${short(config.plannerModel ?? config.model)}, judge ${short(config.judgeModel ?? config.model)}`,
  );
  const runId = o.runId ?? newRunId();
  const artifacts = new RunArtifacts(config.outDir, runId);
  await artifacts.init();

  // Lazy: the provider/key is only resolved on the first LLM call, so smoke runs need no key.
  // Planner and judge may use stronger models than the browser agent (see config.plannerModel).
  const overhead = { inputTokens: 0, outputTokens: 0 };
  const meter = (/** @type {{ inputTokens: number, outputTokens: number }} */ u) => {
    overhead.inputTokens += u.inputTokens;
    overhead.outputTokens += u.outputTokens;
  };
  const llm = lazyLlm(config.plannerModel ?? config.model, meter);
  const judgeLlm = lazyLlm(config.judgeModel ?? config.model, meter);
  // The AI's reading of failures: only with a key for the judge's model, and only if not switched off.
  const judgeModel = config.judgeModel ?? config.model;
  const judgeKey = apiKeyEnvFor(judgeModel);
  const explainer =
    o.explain !== false && config.explainFailures && (!judgeKey || !!process.env[judgeKey])
      ? new FailureExplainer(judgeLlm, artifacts.runDir, logger, judgeModel)
      : undefined;
  const suite = o.suite ? await loadSuite(o.suite) : undefined;
  const baselines = new BaselineStore(
    config.visual.dir ?? path.join(config.outDir, 'baselines'),
    o.url,
  );
  const suitePlanner = suite ? new SuitePlanner(suite) : undefined;

  // Log in once, before anything else: the crawler and every test start with that session. A failed
  // login stops the run here, with a screenshot, instead of failing every test for the same reason.
  const auth = o.auth ?? suite?.auth;
  /** @type {Awaited<ReturnType<typeof performLogin>> | undefined} */
  let login;
  if (auth) {
    events.emit('log', {
      level: 'info',
      scope: 'login',
      message: `Logging in at ${auth.loginUrl}`,
    });
    events.emit('phase', { phase: 'login', status: 'running' });
    login = await performLogin({
      appUrl: o.url,
      auth: AuthSchema.parse(auth),
      cfg: config,
      logger,
      screenshot: path.join(artifacts.runDir, 'login-failed.png'),
    });
    events.emit('phase', { phase: 'login', status: 'done', detail: `as ${login.username}` });
  }
  const useAiPlanner = !suite && !o.goal && o.plan !== false;
  const cache = o.cache !== false;
  const heal = o.heal !== false;
  const planner = suitePlanner
    ? suitePlanner
    : useAiPlanner
      ? new CachedPlanner(
          new LlmPlanner(
            llm,
            {
              maxTests: config.maxTests,
              onReview: (review) => events.emit('plan.review', review),
            },
            logger,
          ),
          path.join(config.outDir, 'plans'),
          {
            replan: !!o.replan || !cache,
            key: `${config.plannerModel ?? config.model}|${config.maxTests}|${PLANNER_VERSION}`,
            onReuse: (tests) => events.emit('plan.reused', { tests }),
          },
          logger,
        )
      : new StaticPlanner();
  // Cross-product theme conformance: read the reference product's themes once, before the tests.
  const themeFrom = o.themeFrom ?? suite?.themeFrom;
  const themeReference = themeFrom
    ? await captureReference({ url: themeFrom, cfg: config, logger })
    : undefined;

  const crawler =
    useAiPlanner && o.crawl !== false
      ? new BfsCrawler(config, logger, { storageState: login?.state })
      : new NoopCrawler();

  // Known third-party noise declared by the suite (analytics, error reporters, font CDNs): logged, never silent.
  const judgeCfg = {
    ignoreNetworkPatterns: [
      ...config.judge.ignoreNetworkPatterns,
      ...(suite?.ignore?.network ?? []),
    ],
    ignoreConsolePatterns: [
      ...config.judge.ignoreConsolePatterns,
      ...(suite?.ignore?.console ?? []),
    ],
  };
  const declared = [...(suite?.ignore?.network ?? []), ...(suite?.ignore?.console ?? [])];
  if (declared.length)
    logger.info(`Ignoring known third-party noise declared by the suite: ${declared.join(', ')}`);

  // the browser agent: Stagehand's agent() by default, or our own tool loop (any model) when configured
  const agent =
    config.agentEngine === 'loop' ? new LoopAgentExecutor(config) : new AgentExecutor(config);
  agent.loggedIn = !!login;
  const fileStore = new FileRecordStore(path.join(config.outDir, 'recordings'));
  const recordStore = suitePlanner
    ? new SeededRecordStore(fileStore, suitePlanner.seeds)
    : fileStore;
  const pipeline = buildPipeline({
    config,
    logger,
    events,
    overheadUsage: () => ({ ...overhead }),
    auth: login
      ? {
          loginUrl: new URL(auth?.loginUrl ?? '/', o.url).toString(),
          username: login.username,
          landedOn: login.landedOn,
        }
      : undefined,
    crawler,
    planner,
    reporter: new CompositeReporter([
      new JsonReporter(artifacts, logger),
      new HtmlReporter(artifacts, logger),
    ]),
    runner: new TestRunner({
      config,
      logger,
      artifacts,
      events,
      signal,
      executor: cache
        ? new CachingExecutor({
            agent,
            replay: new ReplayExecutor(),
            store: recordStore,
            rerecord: !!o.rerecord,
            heal,
          })
        : agent,
      recordStore: cache ? recordStore : undefined,
      fallbackExecutor: cache && heal ? agent : undefined,
      explainer: explainer,
      judge: new EvidenceJudge(judgeCfg, judgeLlm, config.quality, {
        store: baselines,
        cfg: config.visual,
      }),
      baselines,
      themeStates: new ThemeStates({ perTest: config.quality.themeStates }),
      storageState: login?.state,
      themeReference,
    }),
  });

  events.emit('run.started', {
    runId,
    target: { url: o.url, description: o.description, goal: o.goal },
    config: {
      model: config.model,
      plannerModel: config.plannerModel ?? config.model,
      judgeModel: config.judgeModel ?? config.model,
      preset: config.preset,
      agentEngine: config.agentEngine,
      concurrency: config.concurrency,
      headless: config.headless,
      quality: config.quality.gate,
      cache,
    },
  });
  try {
    const final = await pipeline.invoke({
      runId,
      startedAt: new Date().toISOString(),
      target: {
        url: o.url,
        description: o.description ?? suite?.description,
        goal: o.goal,
        expectUrl: o.expectUrl,
        expectText: o.expectText,
      },
      tests: [],
      results: [],
    });
    const report = /** @type {import('../core/types.js').RunReport} */ (final.report);
    events.emit('run.finished', { runId, summary: report.summary });
    return { runId, report };
  } catch (e) {
    events.emit('run.error', { message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * Defer provider/key resolution until the first LLM call, so smoke-only runs need no key.
 * @param {string} modelId
 * @param {(u: { inputTokens: number, outputTokens: number }) => void} [onUsage]
 * @returns {import('../core/ports.js').LlmClient}
 */
function lazyLlm(modelId, onUsage) {
  /** @type {AiSdkLlm | undefined} */
  let real;
  return {
    generateObject: (args) =>
      (real ??= AiSdkLlm.fromModelId(modelId, onUsage)).generateObject(args),
  };
}
