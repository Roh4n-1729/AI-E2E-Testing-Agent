import { BrowserSession } from '../browser/session.js';
import { testFingerprint } from '../storage/recordStore.js';
import { nullEvents } from '../events/runEvents.js';
import { errorMessage } from '../util/misc.js';

/**
 * @import { Config } from '../config/config.js'
 * @import { RunArtifacts } from '../storage/artifacts.js'
 * @import { RunEvents } from '../events/runEvents.js'
 * @import { Logger } from '../util/logger.js'
 * @import { Executor, Judge, RecordStore } from './ports.js'
 * @import { HealEvent, TestCase, TestResult } from './types.js'
 */

/**
 * @typedef {object} TestRunnerDeps
 * @property {Config} config
 * @property {Executor} executor
 * @property {Judge} judge
 * @property {RunArtifacts} artifacts
 * @property {Logger} logger
 * @property {RecordStore} [recordStore]  Where passing agent runs are saved as replayable recordings.
 * @property {Executor} [fallbackExecutor]  Pure agent executor, used to re-verify a replay that the judge failed.
 * @property {RunEvents} [events]  Progress events for the CLI/UI. Default: a bus nobody listens to.
 * @property {AbortSignal} [signal]  Aborting stops running browsers and skips tests that have not started.
 */

/** Runs one test in its own isolated browser: execute -> judge -> (record) -> close. */
export class TestRunner {
  /** @param {TestRunnerDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /** @param {TestCase} test @returns {Promise<TestResult>} */
  async run(test) {
    const { fallbackExecutor, logger } = this.deps;
    const events = this.deps.events ?? nullEvents;
    const started = Date.now();
    events.emit('test.started', { testId: test.id, title: test.title, goal: test.goal });
    const result = await this.#runWithFallback(test, started, fallbackExecutor, logger);
    events.emit('test.finished', {
      testId: test.id,
      title: test.title,
      status: result.verdict.status,
      reason: result.verdict.reason,
      mode: result.mode,
      durationMs: result.durationMs,
      claimMismatch: result.claimMismatch,
      heals: result.heals,
      llmUsage: result.llmUsage,
    });
    return result;
  }

  /**
   * @param {TestCase} test @param {number} started @param {Executor | undefined} fallbackExecutor
   * @param {Logger} logger @returns {Promise<TestResult>}
   */
  async #runWithFallback(test, started, fallbackExecutor, logger) {
    const first = await this.#attempt(test, this.deps.executor);

    // A replay can complete every step and still not reach the goal, either because the app changed
    // (stale recording) or because it regressed. The independent judge already said "fail"; the only
    // way to tell the two apart is to let the agent try the goal on the live app, from scratch. If it
    // also fails the judge, the failure stands. Either way the report says a heal was attempted.
    if (first.mode === 'replay' && first.verdict.status === 'fail' && fallbackExecutor) {
      logger.warn(
        `${test.id}: replay finished but expectations failed; re-checking with the agent`,
      );
      const second = await this.#attempt(test, fallbackExecutor);
      const passed = second.verdict.status === 'pass';
      /** @type {HealEvent} */
      const heal = {
        testId: test.id,
        stepIndex: Math.max(0, first.verdict.checks.length - 1),
        description: 'Replay completed but the expectations failed',
        reason: first.verdict.reason,
        outcome: passed ? 'healed' : 'failed',
      };
      const result = passed ? { ...second, mode: /** @type {const} */ ('healed') } : first;
      return {
        ...result,
        heals: [...result.heals, heal],
        llmUsage: second.llmUsage,
        claimMismatch: passed ? second.claimMismatch : first.claimMismatch,
        durationMs: Date.now() - started,
      };
    }
    return { ...first, durationMs: Date.now() - started };
  }

  /**
   * One isolated browser session: execute, judge, and record the run if the judge passed it.
   * @param {TestCase} test @param {Executor} executor @returns {Promise<TestResult>}
   */
  async #attempt(test, executor) {
    const { config, judge, artifacts, logger, recordStore, signal } = this.deps;
    const events = this.deps.events ?? nullEvents;
    const started = Date.now();
    if (signal?.aborted) return errorResult(test, 'Stopped before this test started', 0);
    const testArtifacts = artifacts.forTest(test.id);
    /** @type {import('./ports.js').TestContext} */
    const ctx = {
      runId: artifacts.runId,
      testId: test.id,
      artifacts: testArtifacts,
      logger: logger.child(test.id),
      events,
    };

    /** @type {BrowserSession | undefined} */
    let session;
    /** @type {(() => void) | undefined} */
    let stopLiveView;
    /** @type {(() => void) | undefined} */
    let onAbort;
    try {
      session = await BrowserSession.open(config, testArtifacts, ctx.logger);
      const s = session;
      s.onScreenshot = (ref) => events.emit('test.screenshot', { testId: test.id, ...ref });
      stopLiveView = s.startLiveView(
        (jpeg) => events.emit('frame', { testId: test.id, jpeg: jpeg.toString('base64') }),
        () => events.liveViewers > 0,
      );
      onAbort = () => void s.close();
      signal?.addEventListener('abort', onAbort, { once: true });
      const outcome = await executor.execute(test, session, ctx);
      const { verdict, evidence } = await judge.judge(test, session, outcome, ctx);
      const claimMismatch =
        outcome.agentClaim !== undefined &&
        outcome.agentClaim.success !== (verdict.status === 'pass');
      // A heal counts only if the independent judge passed the result, whatever the agent said.
      const heals = outcome.heals.map((h) => ({
        ...h,
        outcome:
          verdict.status === 'pass'
            ? /** @type {const} */ ('healed')
            : /** @type {const} */ ('failed'),
      }));

      // Only runs the independent judge passed are worth replaying.
      if (
        recordStore &&
        verdict.status === 'pass' &&
        outcome.recordable &&
        (outcome.mode === 'agent' || outcome.mode === 'healed')
      ) {
        await recordStore.save({
          schemaVersion: 1,
          testId: test.id,
          fingerprint: testFingerprint(test),
          recordedAt: new Date().toISOString(),
          steps: outcome.steps,
        });
        ctx.logger.info(`recorded ${outcome.steps.length} steps for replay`);
      } else if (recordStore && verdict.status === 'pass' && outcome.mode === 'agent') {
        ctx.logger.info(
          'passed, but not recorded: the agent used steps that cannot be replayed deterministically',
        );
      }
      return {
        test,
        mode: outcome.mode,
        verdict,
        evidence,
        agentClaim: outcome.agentClaim,
        claimMismatch,
        heals,
        durationMs: Date.now() - started,
        llmUsage: outcome.llmUsage,
        trace: outcome.trace,
      };
    } catch (e) {
      // Infrastructure failure (browser did not launch, judge crashed): report as an error.
      return errorResult(test, errorMessage(e), Date.now() - started);
    } finally {
      stopLiveView?.();
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      await session?.close();
    }
  }
}

/** @param {TestCase} test @param {string} message @param {number} durationMs @returns {TestResult} */
function errorResult(test, message, durationMs) {
  return {
    test,
    mode: 'agent',
    verdict: { status: 'error', reason: message, checks: [], warnings: [] },
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
    durationMs,
  };
}
