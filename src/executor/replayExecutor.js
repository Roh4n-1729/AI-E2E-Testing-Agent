/**
 * @import { Page } from 'playwright'
 * @import { BrowserSession } from '../browser/session.js'
 * @import { TestContext } from '../core/ports.js'
 * @import { Baseline, ExecutionOutcome, RecordedStep, Recording, TestCase } from '../core/types.js'
 */

import { settle } from '../browser/settle.js';
import { dragPercent, moveMouseToPercent } from './mouse.js';
import { stepCheckpoint } from '../visual/baselines.js';
import { stableSelector } from '../browser/hints.js';

/** An absolute XPath recorded by Stagehand: breaks when one wrapper is added. @param {string} [s] */
const isXPath = (s) => !!s && (s.startsWith('xpath=') || s.startsWith('/'));

export { settle };

const ACTION_TIMEOUT_MS = 8000;
const STEP_SETTLE = { maxMs: 4000, quietMs: 600 };
/** Generous: AI apps stream content for a while after the last click. */
const FINAL_SETTLE = { maxMs: 30_000, quietMs: 2000 };

/** A recorded step no longer works. The caching executor turns this into a self-heal. */
export class ReplayStepError extends Error {
  /**
   * @param {RecordedStep} step @param {unknown} cause @param {Baseline} baseline
   * @param {import('../core/types.js').TraceEntry[]} [trace]  what the replay did before breaking
   */
  constructor(step, cause, baseline, trace = []) {
    super(`Step ${step.index} "${step.description}" failed: ${String(cause).split('\n')[0]}`);
    this.name = 'ReplayStepError';
    this.step = step;
    this.baseline = baseline;
    this.trace = trace;
  }
}

/**
 * Replays recorded steps with plain Playwright: no LLM calls, no tokens.
 * (Not an `Executor` itself: it needs the recording, so CachingExecutor drives it.)
 */
export class ReplayExecutor {
  /**
   * @param {TestCase} test @param {BrowserSession} session @param {TestContext} ctx
   * @param {Recording} recording
   * @param {{ sturdier?: boolean }} [o]  sturdier: before each step that targets an absolute XPath, find a selector
   *   that survives layout changes (test id, id, role and name) while the element is on the page, and replay with
   *   it; the outcome's steps carry the upgraded selectors (the XPath stays as a fallback)
   * @returns {Promise<ExecutionOutcome>}
   */
  async execute(test, session, ctx, recording, o = {}) {
    /** @type {RecordedStep[]} the steps as replayed, possibly with sturdier selectors */
    const replayed = [];
    /** @type {import('../core/types.js').TraceEntry[]} */
    const trace = [];
    await session.goto(test.startUrl);
    const start = await session.screenshot('start');
    let baseline = await session.baseline(test.expectations);
    // A test that starts on a screen reached by earlier steps (exploring deeper) is judged from that screen:
    // its "before" snapshot is retaken once the prefix is replayed, so a check already true there is vacuous.
    const prefixEnd = (test.prefix?.length ?? 0) - 1;
    trace.push({
      index: 0,
      source: 'harness',
      tool: 'goto',
      description: `Open ${test.startUrl}`,
      ok: true,
      screenshot: start.path,
      url: start.url,
      ts: new Date().toISOString(),
    });
    await session.auditState('start', { step: 0 });

    for (const original of recording.steps) {
      let step = original;
      if (o.sturdier && step.kind === 'act' && isXPath(step.selector)) {
        const better = await resolveTarget(session.page, step)
          .then((loc) => loc.waitFor({ state: 'attached', timeout: ACTION_TIMEOUT_MS }))
          .then(() =>
            stableSelector(
              session.page,
              /** @type {string} */ (step.selector),
              step.method ?? 'click',
            ),
          )
          .catch(() => null);
        if (better)
          step = {
            ...step,
            selector: better,
            fallbackSelectors: [
              /** @type {string} */ (step.selector),
              ...(step.fallbackSelectors ?? []),
            ],
          };
      }
      replayed.push(step);
      if (step.kind === 'navigate' && step.index === 0) continue; // the start page is already open
      ctx.logger.debug(`replay ${step.index}: ${step.description}`);
      ctx.events.emit('test.step', {
        testId: test.id,
        source: 'replay',
        description: `${step.index}. ${step.description}`,
      });
      try {
        await runStep(session.page, step);
        await session.settle(STEP_SETTLE);
      } catch (e) {
        trace.push({
          index: trace.length,
          source: 'replay',
          tool: step.kind,
          description: step.description,
          ok: false,
          url: session.page.url(),
          ts: new Date().toISOString(),
        });
        throw new ReplayStepError(step, e, baseline, trace);
      }
      const shot = await session.screenshot(`step-${step.index}`).catch(() => undefined);
      trace.push({
        index: trace.length,
        source: 'replay',
        tool: step.kind === 'act' ? (step.method ?? 'act') : step.kind,
        description: step.description,
        ok: true,
        screenshot: shot?.path,
        url: session.page.url(),
        ts: new Date().toISOString(),
      });
      if (step.kind !== 'wait') {
        await session.auditState(`after step ${step.index}`, { step: step.index });
        await session.visualCapture(stepCheckpoint(step), `after step ${step.index}`);
      }
      if (step.index === prefixEnd) {
        await session.settle(STEP_SETTLE);
        baseline = await session.baseline(test.expectations);
      }
    }
    await session.settle(FINAL_SETTLE);
    return {
      mode: 'replay',
      steps: o.sturdier ? replayed : recording.steps,
      heals: [],
      baseline,
      trace,
    };
  }
}

/**
 * Reach the screen a round-2 test starts on: open the start URL and replay the test's prefix (the recorded steps
 * of the earlier test that ended there), with no AI. The "before" snapshot is taken on that screen. Throws
 * ReplayStepError when a prefix step no longer works.
 * @param {TestCase} test @param {BrowserSession} session @param {TestContext} ctx
 * @returns {Promise<{ completed: RecordedStep[], baseline: Baseline, trace: import('../core/types.js').TraceEntry[] }>}
 */
export async function replayPrefix(test, session, ctx) {
  const steps = (test.prefix ?? []).map((s, i) => ({ ...s, index: i }));
  const out = await new ReplayExecutor().execute({ ...test, prefix: steps }, session, ctx, {
    schemaVersion: 1,
    testId: test.id,
    fingerprint: '',
    recordedAt: '',
    steps,
  });
  return {
    completed: steps,
    baseline: /** @type {Baseline} */ (out.baseline),
    trace: out.trace ?? [],
  };
}

/**
 * Recorded selectors: XPath (Stagehand), CSS and test ids, and Playwright's own role/test-id locators from
 * the loop agent (`internal:role=button[name="Buy"i]`). Anything else is an XPath without its prefix.
 * @param {Page} page @param {string} selector
 */
const toLocator = (page, selector) =>
  page
    .locator(
      /^(xpath=|css=|text=|internal:|role=|#|\.|\/|\[)/.test(selector) ||
        selector.includes('internal:')
        ? selector
        : `xpath=${selector}`,
    )
    .first();

/**
 * The element a recorded step acts on: its stable selector (test id) if that still matches,
 * otherwise each fallback (the XPath) in turn. Waits for whichever appears first.
 * @param {Page} page @param {RecordedStep} step
 */
export async function resolveTarget(page, step) {
  const candidates = [step.selector ?? '', ...(step.fallbackSelectors ?? [])]
    .filter(Boolean)
    .map((s) => toLocator(page, s));
  const [first] = candidates;
  if (!first) throw new Error('recorded step has no selector');
  if (candidates.length === 1) return first;
  const any = candidates.reduce((a, b) => a.or(b));
  await any
    .first()
    .waitFor({ state: 'attached', timeout: ACTION_TIMEOUT_MS })
    .catch(() => undefined);
  for (const c of candidates) if (await c.count().catch(() => 0)) return c;
  return first;
}

/**
 * Execute one recorded step against the live page.
 * @param {Page} page @param {RecordedStep} step
 */
export async function runStep(page, step) {
  const args = step.arguments ?? [];
  switch (step.kind) {
    case 'navigate':
      return void (await page.goto(step.url ?? '', { waitUntil: 'domcontentloaded' }));
    case 'back':
      return void (await page.goBack({ waitUntil: 'domcontentloaded' }));
    case 'wait':
      return void (await page.waitForTimeout(Math.min(Number(args[0] ?? 1000), 10_000)));
    case 'mouse':
      if (step.method === 'drag')
        return void (await dragPercent(
          page,
          Number(args[0] ?? 50),
          Number(args[1] ?? 50),
          Number(args[2] ?? 50),
          Number(args[3] ?? 50),
        ));
      return void (await moveMouseToPercent(page, Number(args[0] ?? 50), Number(args[1] ?? 50)));
    case 'act': {
      const loc = await resolveTarget(page, step);
      const timeout = ACTION_TIMEOUT_MS;
      switch (step.method ?? 'click') {
        case 'click':
          return void (await loc.click({ timeout }));
        case 'doubleClick':
          return void (await loc.dblclick({ timeout }));
        case 'hover':
          return void (await loc.hover({ timeout }));
        case 'fill':
          return void (await loc.fill(args[0] ?? '', { timeout }));
        case 'type':
          return void (await loc.pressSequentially(args[0] ?? '', { timeout }));
        case 'press':
          return void (await loc.press(args[0] ?? 'Enter', { timeout }));
        case 'selectOption':
        case 'selectOptionFromDropdown':
          return void (await loc.selectOption(args[0] ?? '', { timeout }));
        case 'scrollTo':
        case 'scrollIntoView':
          return void (await loc.scrollIntoViewIfNeeded({ timeout }));
        case 'nextChunk':
        case 'prevChunk':
          return; // viewport scrolling only; element actions auto-scroll
        default:
          throw new Error(`unsupported recorded method "${step.method}"`);
      }
    }
  }
}
