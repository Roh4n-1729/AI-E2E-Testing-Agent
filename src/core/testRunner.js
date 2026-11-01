import path from 'node:path';
import { BrowserSession } from '../browser/session.js';
import { testFingerprint } from '../storage/recordStore.js';
import { nullEvents } from '../events/runEvents.js';
import { neededPerson, wasHelped } from './humanHelp.js';
import { errorMessage } from '../util/misc.js';
import { ReplayExecutor, ReplayStepError } from '../executor/replayExecutor.js';

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
 * @property {import('../theme/states.js').ThemeStates} [themeStates]  run-wide memory of theme-audited screens
 * @property {import('../visual/baselines.js').BaselineStore} [baselines]  approved screenshots
 * @property {import('../auth/login.js').StorageState} [storageState]  logged-in session every test starts with
 * @property {import('./types.js').ThemeReference} [themeReference]  check the theme against another product
 * @property {import('../judge/failureExplainer.js').FailureExplainer} [explainer]  the AI's reading of failures
 * @property {Judge} [verifyJudge]  judges a new recording's replay on the test's own checks only (no quality or
 *   visual gates); with config.verifyRecordings, a recording is kept only when that replay passes
 * @property {import('./humanHelp.js').HumanHelp} [help]  a person who can act in the test's browser (human in the
 *   loop); without it, every request for help is answered "nobody can help"
 * @property {import('../browser/host.js').BrowserHost} [browserHost]  one browser window shared by the tests (the
 *   browser is shown); tests then run one at a time and are isolated by cleaning, not by relaunching
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
    let result = await this.#runWithFallback(test, started, fallbackExecutor, logger);
    // A test that stopped because it needed a person already says why: no AI reading, no second try.
    const waitingForPerson = result.verdict.status !== 'pass' && neededPerson(result.help);
    if (waitingForPerson)
      logger.info(
        `${test.id}: needs a person (${result.help?.find((h) => h.answer !== 'done')?.what})`,
      );
    // After the verdict, never before: the explanation reads the evidence, it does not decide anything.
    if (
      result.verdict.status !== 'pass' &&
      !waitingForPerson &&
      this.deps.explainer &&
      !this.deps.signal?.aborted
    ) {
      const explanation = await this.deps.explainer.explain(result);
      if (explanation) result.explanation = explanation;
    }
    // The reading blames the test, not the app: one more try with that lesson, judged on the same checks.
    const e = result.explanation;
    if (
      result.verdict.status === 'fail' &&
      e?.category === 'test-problem' &&
      this.deps.config.retryTestProblems &&
      fallbackExecutor &&
      test.goal.trim() &&
      !this.deps.signal?.aborted
    ) {
      const hint = [e.cause, e.suggestion].filter(Boolean).join(' ');
      logger.info(
        `${test.id}: the AI's reading blames the test, not the app; trying once more with it as a hint`,
      );
      events.emit('test.started', {
        testId: test.id,
        title: test.title,
        goal: test.goal,
        retry: true,
      });
      const second = await this.#attempt(test, fallbackExecutor, hint);
      const passed = second.verdict.status === 'pass';
      // the report shows the second try when it passed (and says so), else the first with its reading
      const shown = passed ? { ...second, durationMs: Date.now() - started } : result;
      const other = passed ? result : second;
      result = {
        ...shown,
        retry: {
          hint,
          passed,
          other: { status: other.verdict.status, reason: other.verdict.reason.slice(0, 300) },
        },
      };
    }
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
      explanation: result.explanation,
      ...(result.help ? { help: result.help } : {}),
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
   * @param {TestCase} test @param {Executor} executor @param {string} [hint]  a second try's lesson
   * @returns {Promise<TestResult>}
   */
  async #attempt(test, executor, hint) {
    const { config, judge, artifacts, logger, recordStore, signal } = this.deps;
    const events = this.deps.events ?? nullEvents;
    const started = Date.now();
    if (signal?.aborted) return errorResult(test, 'Stopped before this test started', 0);
    const testArtifacts = artifacts.forTest(test.id);
    /** @type {import('./humanHelp.js').HelpRequest[]} requests for a person in this attempt, as the harness saw them */
    const help = [];
    /** @type {import('./ports.js').TestContext} */
    const ctx = {
      runId: artifacts.runId,
      testId: test.id,
      artifacts: testArtifacts,
      logger: logger.child(test.id),
      events,
      ...(hint ? { hint } : {}),
      askHuman: async (what) => {
        ctx.logger.info(`asks a person: ${what}`);
        const r = this.deps.help
          ? await this.deps.help.ask(test.id, what, signal)
          : {
              what,
              answer: /** @type {const} */ ('unavailable'),
              ts: new Date().toISOString(),
              waitedMs: 0,
            };
        help.push(r);
        ctx.logger.info(
          r.answer === 'done'
            ? 'a person did it; this run will not be recorded'
            : r.answer === 'unavailable'
              ? 'nobody can help in this run (the browser is not shown)'
              : `no help: ${r.answer}`,
        );
        return r;
      },
    };

    /** @type {BrowserSession | undefined} */
    let session;
    /** @type {(() => void) | undefined} */
    let stopLiveView;
    /** @type {(() => void) | undefined} */
    let onAbort;
    try {
      session = await BrowserSession.open(config, testArtifacts, ctx.logger, {
        themeStates: this.deps.themeStates,
        storageState: this.deps.storageState,
        themeReference: this.deps.themeReference,
        host: this.deps.browserHost,
      });
      const s = session;
      s.onScreenshot = (ref) => events.emit('test.screenshot', { testId: test.id, ...ref });
      s.onUpload = (u) =>
        events.emit('test.step', {
          testId: test.id,
          source: 'harness',
          description: u.file
            ? `The harness chose ${u.file} for the file picker${u.error ? ` (${u.error})` : ''}`
            : `File picker left unanswered: ${u.error}`,
          ok: !u.error,
        });
      stopLiveView = s.startLiveView(
        (jpeg) => events.emit('frame', { testId: test.id, jpeg: jpeg.toString('base64') }),
        () => events.liveViewers > 0,
      );
      // Stop closes the browser under the agent; a shared window closes for good
      const host = this.deps.browserHost;
      onAbort = () => void (host ? host.close() : s.close());
      signal?.addEventListener('abort', onAbort, { once: true });
      const outcome = await executor.execute(test, session, ctx);
      // the live view shows the hand-off: the steps are done, the judge now reads the evidence
      events.emit('test.judging', {
        testId: test.id,
        checks: test.expectations.length,
        mode: outcome.mode,
      });
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

      // Screenshots of a passing test with no baseline yet become the baseline (like recordings, only
      // judge-approved runs count). --update-baselines re-approves every screenshot of a passing test.
      if (this.deps.baselines && verdict.status === 'pass' && evidence.visual?.results) {
        for (const r of evidence.visual.results) {
          const update = config.visual.update && (r.status === 'changed' || r.status === 'size');
          if (r.status !== 'new' && !update) continue;
          if (r.status === 'new' && !config.visual.saveNew) continue;
          await this.deps.baselines.save(
            test.id,
            r.checkpoint,
            path.join(artifacts.runDir, r.current),
            {
              runId: artifacts.runId,
              fingerprint: testFingerprint(test),
              how: update ? 'update' : 'first-pass',
            },
          );
          r.saved = true;
        }
      }

      // Only runs the independent judge passed are worth replaying, and only recordings that DO replay are kept.
      /** @type {TestResult['recording']} */
      let recording;
      if (
        recordStore &&
        verdict.status === 'pass' &&
        outcome.recordable &&
        !wasHelped(help) &&
        (outcome.mode === 'agent' || outcome.mode === 'healed')
      ) {
        const rec = {
          schemaVersion: /** @type {const} */ (1),
          testId: test.id,
          fingerprint: testFingerprint(test),
          recordedAt: new Date().toISOString(),
          steps: outcome.steps,
        };
        const check =
          config.verifyRecordings && this.deps.verifyJudge && !signal?.aborted
            ? await this.#replayOnce(test, rec, ctx)
            : null;
        if (!check || check.ok) {
          const upgraded =
            check?.steps?.filter((s, i) => s.selector !== rec.steps[i]?.selector).length ?? 0;
          if (check?.steps) rec.steps = check.steps;
          if (upgraded)
            ctx.logger.info(
              `${upgraded} step(s) now find their element by test id or by role and name, with the XPath as a fallback`,
            );
          await recordStore.save(rec);
          ctx.logger.info(
            `recorded ${outcome.steps.length} steps for replay${check ? ' (replayed once with no AI: it works)' : ''}`,
          );
          recording = { saved: true, verified: !!check };
        } else {
          ctx.logger.warn(
            `passed, but not recorded: replaying its steps with no AI did not pass (${check.reason}); the next run uses the agent again`,
          );
          recording = { saved: false, verified: false, reason: check.reason };
        }
      } else if (recordStore && verdict.status === 'pass' && wasHelped(help)) {
        ctx.logger.info(
          "passed with a person's help: not recorded, a replay cannot repeat what they did",
        );
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
        inputs: testInputs(outcome),
        ...(recording ? { recording } : {}),
        ...(help.length ? { help } : {}),
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

  /**
   * Replay a new recording once in a fresh browser, with no AI, and judge it on the test's own checks. Catches
   * recordings that only worked because of something the agent did that the steps do not capture (a wait, a
   * hover, an element found by text that now has another position), before a later run or CI finds out.
   * @param {TestCase} test @param {import('./types.js').Recording} recording
   * @param {import('./ports.js').TestContext} ctx
   * While replaying, steps that target an absolute XPath get a sturdier selector (test id, id, or role and name)
   * if one exists, and the replay uses it, so the saved recording is the one that just worked.
   * @returns {Promise<{ ok: boolean, reason?: string, steps?: import('./types.js').RecordedStep[] }>}
   */
  async #replayOnce(test, recording, ctx) {
    const { config, artifacts } = this.deps;
    const judge = /** @type {Judge} */ (this.deps.verifyJudge);
    // the test's own checks only: no quality audits or screenshots to compare, so it stays quick
    const cfg = {
      ...config,
      quality: { ...config.quality, gate: /** @type {const} */ ('off') },
      visual: { ...config.visual, gate: /** @type {const} */ ('off') },
    };
    const checkArtifacts = artifacts.forTest(`${test.id}--replay-check`);
    const quiet = { ...ctx, artifacts: checkArtifacts, events: nullEvents };
    ctx.logger.info('checking the new recording: replaying it once with no AI');
    /** @type {BrowserSession | undefined} */
    let session;
    try {
      session = await BrowserSession.open(cfg, checkArtifacts, ctx.logger, {
        storageState: this.deps.storageState,
        host: this.deps.browserHost,
      });
      const outcome = await new ReplayExecutor().execute(test, session, quiet, recording, {
        sturdier: true,
      });
      const { verdict } = await judge.judge(test, session, outcome, quiet);
      return verdict.status === 'pass'
        ? { ok: true, steps: outcome.steps }
        : { ok: false, reason: verdict.reason };
    } catch (e) {
      return {
        ok: false,
        reason:
          e instanceof ReplayStepError ? e.message : `the replay could not run: ${errorMessage(e)}`,
      };
    } finally {
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

/**
 * What the AI agent and Playwright were given, and who wrote Playwright's steps: the suite, an earlier run's
 * recording, the agent in this run (its actions, saved as steps), or the harness alone (smoke check).
 * @param {import('./types.js').ExecutionOutcome} outcome
 * @returns {import('./types.js').TestInputs}
 */
export function testInputs(outcome) {
  const replayed = outcome.mode === 'replay' || outcome.mode === 'healed';
  /** @type {import('./types.js').TestInputs['playwright']['source']} */
  const source =
    replayed && outcome.recordedAt === 'suite'
      ? 'suite'
      : replayed
        ? 'recording'
        : outcome.mode === 'agent'
          ? 'agent'
          : 'harness';
  return {
    ...(outcome.agentInput ? { agent: outcome.agentInput } : {}),
    playwright: {
      steps: outcome.steps,
      source,
      ...(replayed && outcome.recordedAt && outcome.recordedAt !== 'suite'
        ? { recordedAt: outcome.recordedAt }
        : {}),
    },
  };
}
