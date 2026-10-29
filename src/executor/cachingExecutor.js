import { testFingerprint } from '../storage/recordStore.js';
import { ReplayStepError } from './replayExecutor.js';
import { reindex } from './steps.js';

/**
 * @import { AgentExecutor } from './agentExecutor.js'
 * @import { ReplayExecutor } from './replayExecutor.js'
 * @import { Executor, RecordStore, TestContext } from '../core/ports.js'
 * @import { BrowserSession } from '../browser/session.js'
 * @import { ExecutionOutcome, HealEvent, TestCase } from '../core/types.js'
 */

/**
 * Agents author and repair, plain Playwright replays.
 *  - no valid recording        -> the agent runs (and the runner records it if the judge passes)
 *  - recording, steps all work  -> replay: zero LLM calls
 *  - a step breaks             -> the agent continues from the current page (self-heal), logged
 * Whatever happens, the judge still decides pass/fail from independent evidence afterwards.
 * @implements {Executor}
 */
export class CachingExecutor {
  /**
   * @param {{ agent: AgentExecutor, replay: ReplayExecutor, store: RecordStore, rerecord?: boolean, heal?: boolean }} deps
   *   heal: false = a broken replay step is a plain failure (deterministic, no LLM; for CI and evaluation).
   */
  constructor({ agent, replay, store, rerecord = false, heal = true }) {
    this.agent = agent;
    this.replay = replay;
    this.store = store;
    this.rerecord = rerecord;
    this.heal = heal;
  }

  /** @param {TestCase} test @param {BrowserSession} session @param {TestContext} ctx @returns {Promise<ExecutionOutcome>} */
  async execute(test, session, ctx) {
    const recording = this.rerecord || !test.goal.trim() ? null : await this.store.load(test.id);
    if (!recording || recording.fingerprint !== testFingerprint(test)) {
      return this.agent.execute(test, session, ctx);
    }

    ctx.logger.info(`replaying recording (${recording.steps.length} steps, no LLM)`);
    try {
      return await this.replay.execute(test, session, ctx, recording);
    } catch (e) {
      if (!(e instanceof ReplayStepError)) throw e;
      if (!this.heal) {
        ctx.logger.warn(`${e.message} (healing is off)`);
        return {
          mode: 'replay',
          steps: recording.steps,
          heals: [],
          baseline: e.baseline,
          trace: e.trace,
          failure: e.message,
        };
      }
      ctx.logger.warn(`${e.message}; asking the agent to heal`);
      const completed = recording.steps.slice(0, e.step.index);
      const out = await this.agent.execute(test, session, ctx, {
        completed,
        failed: e.step,
        baseline: e.baseline,
      });
      const added = out.steps.slice(completed.length).find((s) => s.kind === 'act');
      /** @type {HealEvent} */
      const heal = {
        testId: test.id,
        stepIndex: e.step.index,
        description: e.step.description,
        oldSelector: e.step.selector,
        newSelector: added?.selector,
        reason: e.message,
        // provisional: the TestRunner overwrites this with the JUDGE's verdict, never the agent's claim
        outcome: 'failed',
      };
      const trace = [...e.trace, ...(out.trace ?? [])].map((t, i) => ({ ...t, index: i }));
      return { ...out, mode: 'healed', steps: reindex(out.steps), heals: [heal], trace };
    }
  }
}
