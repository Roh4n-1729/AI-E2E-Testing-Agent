import { tool } from 'ai';
import { z } from 'zod';
import { describeHints, readHints, stableSelector } from '../browser/hints.js';
import { errorMessage } from '../util/misc.js';
import { moveMouseToPercent } from './mouse.js';
import { actionsToSteps } from './steps.js';

/**
 * @import { BrowserSession } from '../browser/session.js'
 * @import { AgentClaim } from '../core/types.js'
 * @import { PageHint } from '../browser/hints.js'
 * @import { Config } from '../config/config.js'
 * @import { Executor, TestContext } from '../core/ports.js'
 * @import { ExecutionOutcome, RecordedStep, ResumeContext, TestCase, TraceEntry } from '../core/types.js'
 */

/** Tools that only look at the page. */
const OBSERVE = new Set([
  'screenshot',
  'ariaTree',
  'extract',
  'think',
  'appTestIds',
  'harnessStatus',
]);

/**
 * An LLM agent (Stagehand) drives the browser toward the test goal, and what it did is captured
 * as replayable steps (`outcome.steps`, `outcome.recordable`) and a run log (`outcome.trace`).
 * Tests without a goal are deterministic smoke tests: navigate only, zero LLM calls.
 *
 * With `resume`, the agent continues from the CURRENT page state after a replay step broke
 * (self-healing); the completed steps are kept and the new ones appended.
 *
 * Apps that expose test ids get two extra tools (list them, act on one), see browser/hints.js.
 * @implements {Executor}
 */
export class AgentExecutor {
  /** @param {Config} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    /** the run logged in first: tests share that session, so none may end it */
    this.loggedIn = false;
  }

  /**
   * @param {TestCase} test @param {BrowserSession} session @param {TestContext} ctx
   * @param {ResumeContext} [resume]
   * @returns {Promise<ExecutionOutcome>}
   */
  async execute(test, session, ctx, resume) {
    /** @type {RecordedStep[]} */
    const prior = resume
      ? resume.completed
      : [{ index: 0, kind: 'navigate', description: `Open ${test.startUrl}`, url: test.startUrl }];
    /** @type {TraceEntry[]} */
    const trace = [];
    const log = (/** @type {Omit<TraceEntry, 'index' | 'ts'>} */ e) => {
      const entry = { index: trace.length, ts: new Date().toISOString(), ...e };
      trace.push(entry);
      return entry;
    };
    try {
      /** @type {import('../core/types.js').Baseline} */
      let baseline;
      if (resume) {
        baseline = resume.baseline;
        const shot = await session.screenshot('resume');
        log({
          source: 'harness',
          tool: 'resume',
          description: `Replay broke at "${resume.failed.description}"; the agent takes over here`,
          ok: false,
          screenshot: shot.path,
          url: shot.url,
        });
      } else {
        await session.goto(test.startUrl);
        const shot = await session.screenshot('start');
        baseline = await session.baseline(test.expectations);
        log({
          source: 'harness',
          tool: 'goto',
          description: `Open ${test.startUrl}`,
          ok: true,
          screenshot: shot.path,
          url: shot.url,
        });
        await session.auditState('start', { step: 0 });
      }

      if (!test.goal.trim()) {
        return { mode: 'deterministic', steps: prior, heals: [], baseline, trace };
      }

      const hints = await readHints(session.page);
      const useHints = hints.some((h) => h.selector || h.hint);
      /** @type {Map<string, string>} xpath -> stable selector, resolved right after each act */
      const stable = new Map();
      /** @type {TraceEntry[]} entries still waiting for the screenshot taken after them */
      let pending = [];
      /** did the agent change anything since the last theme check (not just look around)? */
      let acted = false;

      const agent = session.stagehand.agent({
        mode: 'dom',
        model: { modelName: this.cfg.model, thinkingEffort: this.cfg.agentThinkingEffort },
        tools: {
          hoverAt: hoverAtTool(session),
          harnessStatus: harnessStatusTool(session),
          ...(useHints ? testIdTools(session) : {}),
        },
      });
      const result = await agent.execute({
        instruction: buildInstruction(test, resume, useHints ? hints : [], this.loggedIn),
        maxSteps: test.maxSteps ?? this.cfg.maxSteps,
        // a structured final report instead of prose: shown next to the verdict, never used for it
        output: FinalReportSchema,
        callbacks: {
          onEvidence: async (event) => {
            if (event.type === 'screenshot') {
              const ref = await session.saveScreenshotBytes('agent', event.screenshot, event.url);
              for (const e of pending) e.screenshot ??= ref.path;
              pending = [];
            } else if (event.type === 'step_observed') {
              // Stagehand awaits this callback before its next model call, so the page holds still:
              // a new screen the agent reached gets its theme audit here (scroll-safe, restored after).
              if (acted) {
                acted = false;
                await session.auditState(`after step ${trace.length - 1}`, {
                  step: trace.length - 1,
                });
              }
            } else if (event.type === 'step_finished') {
              const ok = event.toolOutput?.ok !== false;
              const description = describeAgentStep(event);
              const entry = log({
                source: 'agent',
                tool: event.actionName,
                description,
                ok,
                observe: OBSERVE.has(event.actionName),
                url: session.page.url(),
              });
              pending.push(entry);
              if (!OBSERVE.has(event.actionName) && event.actionName !== 'done') acted = true;
              ctx.events.emit('test.step', { testId: test.id, source: 'agent', description, ok });
              // While the element is (very likely) still on the page, find a selector that will
              // outlive layout changes. Recordings then prefer it over the XPath.
              const pa = playwrightArgs(event.toolOutput?.result);
              if (pa?.selector && !stable.has(pa.selector)) {
                const s = await stableSelector(session.page, pa.selector, pa.method ?? 'click');
                if (s) stable.set(pa.selector, s);
              }
            }
          },
        },
      });
      ctx.logger.debug(
        `agent finished: success=${result.success} actions=${result.actions.length}`,
      );

      const { steps, recordable } = actionsToSteps(result.actions, prior.length, stable);
      return {
        mode: 'agent',
        agentClaim: toClaim(result),
        steps: [...prior, ...steps],
        recordable: recordable && result.success,
        heals: [],
        baseline,
        trace,
        llmUsage: result.usage
          ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }
          : undefined,
      };
    } catch (e) {
      return {
        mode: test.goal.trim() ? 'agent' : 'deterministic',
        steps: prior,
        heals: [],
        trace,
        error: errorMessage(e),
      };
    }
  }
}

/** What the agent reports when it finishes (Stagehand's `output` schema). */
export const FinalReportSchema = z.object({
  status: z
    .enum(['done', 'blocked', 'app-error'])
    .describe(
      'done: the goal is achieved. blocked: you could not do it (control missing, unclear goal). app-error: the app itself failed (error page, crash, failed request)',
    ),
  summary: z.string().describe('One or two plain sentences: what you did and what happened'),
  observed: z
    .array(z.string())
    .max(6)
    .describe('Short facts you saw on the page that support your status, e.g. "Cart shows (2)"'),
  valuesUsed: z
    .array(z.string())
    .max(6)
    .optional()
    .describe('Test data you typed that the goal did not give you, e.g. "email: test@example.com"'),
});

/**
 * The agent's claim, from its structured report when it gave one (older Stagehand results and failed
 * reports fall back to success + message). Recorded for comparison, never used for the verdict.
 * @param {{ success: boolean, message: string, output?: Record<string, unknown> }} result
 * @returns {AgentClaim}
 */
export function toClaim(result) {
  const parsed = FinalReportSchema.safeParse(result.output);
  if (!parsed.success) return { success: result.success, message: result.message };
  const r = parsed.data;
  return {
    success: result.success && r.status === 'done',
    message: r.summary || result.message,
    status: r.status,
    observed: r.observed,
    ...(r.valuesUsed?.length ? { valuesUsed: r.valuesUsed } : {}),
  };
}

/**
 * Read-only view of what the harness has seen (console errors, failed requests, an error screen), so the
 * agent can tell its own mistake from an app failure and stop early instead of retrying. It cannot change
 * the verdict: the judge reads its own evidence.
 * @param {BrowserSession} session
 */
export function harnessStatusTool(session) {
  return tool({
    description:
      'Read what the test harness has seen so far: current URL, an error screen if the page shows one, and the console ' +
      'errors and failed network requests since the test started. Call it when the page looks wrong, a step had no ' +
      'effect, or before you report app-error. It does not change the page.',
    inputSchema: z.object({
      why: z.string().describe('What made you check'),
    }),
    execute: async () => session.harnessStatus(),
  });
}

/** @param {any} result @returns {{ selector?: string, method?: string } | undefined} */
function playwrightArgs(result) {
  const out = result?.output ?? result;
  const pa = out?.playwrightArguments;
  return pa && typeof pa === 'object' && !Array.isArray(pa) ? pa : undefined;
}

/**
 * Lets the agent move the real mouse to a spot, for controls that only appear on hover (toolbars in
 * full-screen/presentation mode, hover menus). Positions are percentages of the viewport, so they
 * are replayable at any window size. Recorded as a `mouse` step.
 * @param {BrowserSession} session
 */
export function hoverAtTool(session) {
  return tool({
    description:
      'Move the mouse pointer to a position in the viewport WITHOUT clicking, to reveal controls that only show on hover ' +
      '(e.g. a toolbar in full-screen or presentation mode, usually near an edge or corner). ' +
      'xPercent/yPercent are 0-100 of the viewport (0,0 = top-left, 100,100 = bottom-right). ' +
      'After hovering, take a screenshot or read the page again to see what appeared, then act on it.',
    inputSchema: z.object({
      xPercent: z.number().min(0).max(100),
      yPercent: z.number().min(0).max(100),
      why: z.string().describe('What you expect to appear'),
    }),
    execute: async ({ xPercent, yPercent }) => {
      await moveMouseToPercent(session.page, xPercent, yPercent);
      return { ok: true, movedTo: `${xPercent}%, ${yPercent}%` };
    },
  });
}

/**
 * Exact, cheap, replayable actions for apps that expose test ids. Hidden controls are included:
 * hovering one (by test id) is how hover-revealed toolbars get opened.
 * @param {BrowserSession} session
 */
export function testIdTools(session) {
  return {
    appTestIds: tool({
      description:
        'List the stable test ids (data-testid etc.) and developer hints on the CURRENT page, including controls that are currently hidden.',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, elements: describeHints(await readHints(session.page)) }),
    }),
    useTestId: tool({
      description:
        'Act on an element by the exact selector returned by appTestIds. action: click | hover (also reveals hover-only controls) | fill (needs value) | press (key name in value, e.g. Enter).',
      inputSchema: z.object({
        selector: z.string().describe('e.g. [data-testid="export"]'),
        action: z.enum(['click', 'hover', 'fill', 'press']),
        value: z.string().optional(),
      }),
      execute: async ({ selector, action, value }) => {
        if (!/^\[data-[\w-]+=/.test(selector))
          return { ok: false, error: 'Use a selector exactly as listed by appTestIds' };
        const loc = session.page.locator(selector).first();
        try {
          if (action === 'click') await loc.click({ timeout: 8000 });
          else if (action === 'hover') await loc.hover({ timeout: 8000, force: true });
          else if (action === 'fill') await loc.fill(value ?? '', { timeout: 8000 });
          else await loc.press(value ?? 'Enter', { timeout: 8000 });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: errorMessage(e).split('\n')[0] };
        }
      },
    }),
  };
}

/** Human-readable one-liner for an agent tool call. @param {{ actionName: string, actionArgs: Record<string, any> }} e */
export function describeAgentStep(e) {
  const a = e.actionArgs ?? {};
  switch (e.actionName) {
    case 'act':
      return String(a.action ?? 'act').slice(0, 160);
    case 'goto':
      return `Open ${a.url}`;
    case 'fillForm':
      return `Fill form: ${(a.fields ?? []).map((/** @type {any} */ f) => f.action ?? f).join('; ')}`.slice(
        0,
        160,
      );
    case 'hoverAt':
      return `Hover at ${a.xPercent}%, ${a.yPercent}%${a.why ? ` (${a.why})` : ''}`;
    case 'useTestId':
      return `${a.action} ${a.selector}${a.value ? ` "${a.value}"` : ''}`;
    case 'appTestIds':
      return 'Read the test ids on the page';
    case 'ariaTree':
      return 'Read the page structure';
    case 'screenshot':
      return 'Looked at the page';
    case 'scroll':
      return `Scroll ${a.direction ?? ''}`.trim();
    case 'wait':
      return `Wait ${a.timeMs ?? a.time ?? ''}ms`;
    case 'navback':
      return 'Go back';
    case 'keys':
      return `Press ${a.keys ?? a.text ?? ''}`;
    case 'think':
      return 'Planning the next step';
    case 'extract':
      return `Read: ${a.instruction ?? ''}`.slice(0, 160);
    case 'done':
      return 'Finished';
    default: {
      const arg = a.action ?? a.url ?? a.text ?? '';
      return arg ? `${e.actionName}: ${String(arg).slice(0, 140)}` : e.actionName;
    }
  }
}

/** @param {TestCase} test @param {ResumeContext} [resume] @param {PageHint[]} [hints] */
function buildInstruction(test, resume, hints = [], loggedIn = false) {
  const lines = [
    `You are testing a web application starting at ${test.startUrl}.`,
    `Goal: ${test.goal}`,
    'Act like a real user. Use the values the goal gives you. If a form field must be filled and the goal',
    'gives no value, use obviously fake test data (e.g. "Test User", "test@example.com", "1 Test Street")',
    'and say which values you used; never make up passwords, card numbers or other secrets. If the goal cannot be',
    'achieved, stop and say so plainly: your report will be checked against independent',
    'evidence from the browser, so an inaccurate claim of success will be caught.',
    'If the page looks broken (an error screen, nothing happens after a click), call harnessStatus: it shows the',
    'console errors and failed requests the harness saw. When the app itself failed, stop and finish with',
    'status "app-error" instead of retrying or going back and forth.',
    'Some controls are hidden until the pointer moves or hovers (toolbars in full-screen or presentation',
    'mode, hover menus). If a control you expect is not visible, use the hoverAt tool (usually near an',
    'edge or corner), look again, and only then conclude it does not exist.',
    'Prefer finishing the goal in the screen where it naturally belongs: do not wander into other modes.',
    'Take the shortest path: if the app offers a sample or template that gets you to the needed state, use it,',
    'unless the goal is about creating that state.',
  ];
  if (loggedIn)
    lines.push(
      '',
      'You are already logged in. Do not log out, change the password or delete the account unless the goal',
      'says so: other tests running at the same time use the same session.',
    );
  if (hints.length) {
    lines.push(
      '',
      'This app exposes stable test ids. Prefer useTestId with a selector from appTestIds over act:',
      'it is exact and replayable. Call appTestIds again after the page changes. Current page:',
      describeHints(hints),
    );
  }
  if (resume) {
    lines.push(
      '',
      'A recorded run of this test broke partway, and the browser is now in the state reached after',
      'these already-completed steps:',
      ...resume.completed.map((s) => `  ${s.index}. ${s.description}`),
      `The step that failed was: "${resume.failed.description}" (the page may have changed).`,
      'Continue from the CURRENT page, do not restart, and finish the goal.',
    );
  }
  return lines.join('\n');
}
