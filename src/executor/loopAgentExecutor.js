import { generateText, hasToolCall, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { readHints } from '../browser/hints.js';
import { resolveModel } from '../llm/aiSdkLlm.js';
import { errorMessage } from '../util/misc.js';
import { moveMouseToPercent } from './mouse.js';
import {
  FinalReportSchema,
  buildInstruction,
  reachStart,
  harnessStatusTool,
  hoverAtTool,
  testIdTools,
} from './agentExecutor.js';

/**
 * @import { LanguageModel } from 'ai'
 * @import { BrowserSession } from '../browser/session.js'
 * @import { Config } from '../config/config.js'
 * @import { Executor, TestContext } from '../core/ports.js'
 * @import { AgentClaim, ExecutionOutcome, RecordedStep, ResumeContext, TestCase, TraceEntry } from '../core/types.js'
 */

/**
 * Our own agent loop (AIE2E_AGENT_ENGINE=loop): the AI SDK's tool loop with any model id, driving the page
 * through Playwright's accessibility snapshot. The model reads the page as a tree of roles and names with
 * element refs (`page.ariaSnapshot({ mode: 'ai' })`, the mechanism Playwright MCP uses) and acts on a ref.
 * Every action is resolved to Playwright's own best locator (`locator.normalize()`: test id, then role and
 * name) and recorded as a replay step, so recordings, replay and healing work exactly as with Stagehand.
 *
 * Why: Stagehand 3.7.3's agent() cannot use the newest models (its loop breaks their thinking signatures),
 * and Stagehand 4 removed agent() altogether. With our own loop the model is a setting, the tools are ours,
 * and no LLM is needed to find an element: the model names it by ref.
 * @implements {Executor}
 */
export class LoopAgentExecutor {
  /** @param {Config} cfg @param {{ model?: LanguageModel }} [opts]  model: injected in tests */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.model = opts.model;
    /** the run logged in first: tests share that session, so none may end it */
    this.loggedIn = false;
  }

  /**
   * @param {TestCase} test @param {BrowserSession} session @param {TestContext} ctx
   * @param {ResumeContext} [resume]
   * @returns {Promise<ExecutionOutcome>}
   */
  async execute(test, session, ctx, resume) {
    // Exploring deeper: Playwright first replays the steps that reach the screen this test starts on.
    if (!resume && test.prefix?.length) {
      const reached = await reachStart(test, session, ctx);
      if ('failure' in reached) return reached.failure;
      resume = reached;
    }
    /** @type {RecordedStep[]} */
    const prior = resume
      ? resume.completed
      : [{ index: 0, kind: 'navigate', description: `Open ${test.startUrl}`, url: test.startUrl }];
    /** @type {TraceEntry[]} */
    const trace = resume && !resume.failed ? [...(resume.trace ?? [])] : [];
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
          description: resume.failed
            ? `Replay broke at "${resume.failed.description}"; the agent takes over here`
            : `On the screen where "${test.startsFrom?.title ?? 'an earlier test'}" ended; the agent takes over here`,
          ok: !resume.failed,
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
      if (!test.goal.trim())
        return { mode: 'deterministic', steps: prior, heals: [], baseline, trace };

      const hints = await readHints(session.page);
      const useHints = hints.some((h) => h.selector || h.hint);
      /** @type {RecordedStep[]} */
      const steps = [];
      let recordable = true;
      /** @type {z.infer<typeof FinalReportSchema> | undefined} */
      let report;

      /** One page-changing action: run it, settle, screenshot, log, record. */
      const act = async (
        /** @type {string} */ name,
        /** @type {string} */ description,
        /** @type {() => Promise<RecordedStep | null>} */ run,
      ) => {
        try {
          const step = await run();
          await session.settle({ maxMs: 5000, quietMs: 400 });
          if (step) steps.push({ ...step, index: prior.length + steps.length });
          else recordable = false;
          const shot = await session.screenshot(`agent-${trace.length}`, 'agent');
          log({
            source: 'agent',
            tool: name,
            description,
            ok: true,
            screenshot: shot.path,
            url: shot.url,
          });
          ctx.events.emit('test.step', { testId: test.id, source: 'agent', description, ok: true });
          await session.auditState(`after step ${trace.length - 1}`, { step: trace.length - 1 });
          return {
            ok: true,
            url: session.page.url(),
            title: await session.page.title().catch(() => ''),
          };
        } catch (e) {
          const error = errorMessage(e).split('\n')[0];
          log({ source: 'agent', tool: name, description, ok: false, url: session.page.url() });
          ctx.events.emit('test.step', {
            testId: test.id,
            source: 'agent',
            description,
            ok: false,
          });
          return {
            ok: false,
            error: `${error}. Take a new snapshot: refs change when the page changes.`,
          };
        }
      };
      /** Look without changing anything: logged as an observation, never recorded. */
      const look = (/** @type {string} */ name, /** @type {string} */ description) => {
        log({
          source: 'agent',
          tool: name,
          description,
          ok: true,
          observe: true,
          url: session.page.url(),
        });
      };
      /** The element behind a ref from the last snapshot, and the durable selector a replay will use. */
      const target = async (/** @type {string} */ ref) => {
        if (!/^e\d+$/.test(ref))
          throw new Error(`"${ref}" is not a ref from the snapshot (e.g. e12)`);
        const loc = session.page.locator(`aria-ref=${ref}`);
        if ((await loc.count()) !== 1) throw new Error(`Ref ${ref} is not on the page any more`);
        const normal = await loc.normalize().catch(() => loc);
        const selector = /** @type {any} */ (normal)._selector;
        return {
          loc,
          selector:
            typeof selector === 'string' && !selector.includes('aria-ref') ? selector : null,
        };
      };
      const element = z
        .string()
        .describe('What the element is, in words, e.g. "the Add to cart button of the Backpack"');
      const ref = z.string().describe('The element ref from the latest snapshot, e.g. e12');

      const hoverAt = hoverAtTool(session);
      /** The shared test-id tools, with the action recorded like every other step. */
      const recordedTestIdTools = () => {
        const base = testIdTools(session);
        return {
          appTestIds: tool({
            ...base.appTestIds,
            execute: async (a, o) => {
              look('appTestIds', 'Read the test ids on the page');
              return /** @type {any} */ (base.appTestIds).execute(a, o);
            },
          }),
          useTestId: tool({
            ...base.useTestId,
            execute: async (a, o) =>
              act(
                'useTestId',
                `${a.action} ${a.selector}${a.value ? ` "${a.value}"` : ''}`,
                async () => {
                  const r = await /** @type {any} */ (base.useTestId).execute(a, o);
                  if (!r?.ok) throw new Error(r?.error ?? 'failed');
                  return actStep(
                    `${a.action} ${a.selector}`,
                    a.selector,
                    a.action,
                    a.value ? [a.value] : [],
                  );
                },
              ),
          }),
        };
      };
      const tools = {
        snapshot: tool({
          description:
            'Read the current page as an accessibility tree: roles, names, text and a ref for every element ([ref=e12]). ' +
            'Call it first, and again after anything changes the page: refs are only valid for the latest snapshot.',
          inputSchema: z.object({}),
          execute: async () => {
            look('ariaTree', 'Read the page structure');
            const tree = await session.page.ariaSnapshot({ mode: 'ai' });
            return {
              url: session.page.url(),
              title: await session.page.title(),
              tree:
                tree.length > 12_000
                  ? `${tree.slice(0, 12_000)}\n… (cut: scroll or act to see more)`
                  : tree,
            };
          },
        }),
        click: tool({
          description: 'Click an element by its ref.',
          inputSchema: z.object({ ref, element }),
          execute: async (a) =>
            act('click', `Click ${a.element}`, async () => {
              const t = await target(a.ref);
              await t.loc.click({ timeout: 8000 });
              return t.selector ? actStep(`Click ${a.element}`, t.selector, 'click', []) : null;
            }),
        }),
        type: tool({
          description:
            'Type text into a text field by its ref (replaces what is there). Set submit: true to press Enter after it: ' +
            'needed to add an item from a single input (a todo, a tag), run a search or send a one-field form. ' +
            'Without submit nothing is sent, and typing into the same field again replaces the text.',
          inputSchema: z.object({ ref, element, text: z.string(), submit: z.boolean().optional() }),
          execute: async (a) =>
            act('type', `Type "${a.text}" into ${a.element}`, async () => {
              const t = await target(a.ref);
              await t.loc.fill(a.text, { timeout: 8000 });
              if (a.submit) await t.loc.press('Enter');
              if (!t.selector) return null;
              const step = actStep(`Type "${a.text}" into ${a.element}`, t.selector, 'fill', [
                a.text,
              ]);
              if (a.submit) {
                steps.push({ ...step, index: prior.length + steps.length });
                return actStep('Press Enter', t.selector, 'press', ['Enter']);
              }
              return step;
            }),
        }),
        select: tool({
          description:
            'Choose an option in a dropdown (<select>) by its ref; value is the option text or value.',
          inputSchema: z.object({ ref, element, value: z.string() }),
          execute: async (a) =>
            act('select', `Choose "${a.value}" in ${a.element}`, async () => {
              const t = await target(a.ref);
              await t.loc
                .selectOption(a.value, { timeout: 8000 })
                .catch(() => t.loc.selectOption({ label: a.value }, { timeout: 8000 }));
              return t.selector
                ? actStep(`Choose "${a.value}"`, t.selector, 'selectOption', [a.value])
                : null;
            }),
        }),
        hover: tool({
          description: 'Move the pointer over an element by its ref (opens hover menus).',
          inputSchema: z.object({ ref, element }),
          execute: async (a) =>
            act('hover', `Hover over ${a.element}`, async () => {
              const t = await target(a.ref);
              await t.loc.hover({ timeout: 8000 });
              return t.selector
                ? actStep(`Hover over ${a.element}`, t.selector, 'hover', [])
                : null;
            }),
        }),
        press: tool({
          description: 'Press a key on the page, e.g. Enter, Escape, ArrowDown, Tab.',
          inputSchema: z.object({ key: z.string() }),
          execute: async (a) =>
            act('keys', `Press ${a.key}`, async () => {
              await session.page.keyboard.press(a.key);
              return actStep(`Press ${a.key}`, 'body', 'press', [a.key]);
            }),
        }),
        navigate: tool({
          description: 'Open a URL of the app under test (same site only).',
          inputSchema: z.object({ url: z.string() }),
          execute: async (a) => {
            const to = new URL(a.url, session.page.url());
            if (to.origin !== new URL(test.startUrl).origin)
              return { ok: false, error: 'Only pages of the app under test can be opened' };
            return act('goto', `Open ${to.href}`, async () => {
              await session.goto(to.href);
              return { index: 0, kind: 'navigate', description: `Open ${to.href}`, url: to.href };
            });
          },
        }),
        back: tool({
          description: 'Go back to the previous page.',
          inputSchema: z.object({}),
          execute: async () =>
            act('navback', 'Go back', async () => {
              await session.page.goBack({ waitUntil: 'domcontentloaded' });
              return { index: 0, kind: 'back', description: 'Go back' };
            }),
        }),
        scroll: tool({
          description: 'Scroll the page to see more of it.',
          inputSchema: z.object({ direction: z.enum(['down', 'up']) }),
          execute: async (a) => {
            look('scroll', `Scroll ${a.direction}`);
            await session.page.mouse.wheel(0, a.direction === 'down' ? 600 : -600);
            return { ok: true };
          },
        }),
        screenshot: tool({
          description:
            'Look at the page as an image, when the tree is not enough (layout, images, colours).',
          inputSchema: z.object({}),
          execute: async () => {
            look('screenshot', 'Looked at the page');
            const bytes = await session.page.screenshot({ type: 'jpeg', quality: 60 });
            return { data: Buffer.from(bytes).toString('base64') };
          },
          toModelOutput: (out) => ({
            type: 'content',
            value: [{ type: 'media', data: out.data, mediaType: 'image/jpeg' }],
          }),
        }),
        hoverAt: tool({
          description: hoverAt.description,
          inputSchema: /** @type {typeof hoverAt.inputSchema} */ (hoverAt.inputSchema),
          execute: async (a) =>
            act('hoverAt', `Hover at ${a.xPercent}%, ${a.yPercent}% (${a.why})`, async () => {
              await moveMouseToPercent(session.page, a.xPercent, a.yPercent);
              return {
                index: 0,
                kind: 'mouse',
                description: `Hover at ${a.xPercent}%, ${a.yPercent}%`,
                arguments: [String(a.xPercent), String(a.yPercent)],
              };
            }),
        }),
        harnessStatus: harnessStatusTool(session),
        ...(useHints ? recordedTestIdTools() : {}),
        finish: tool({
          description:
            'End the test with your report. Call it once the goal is achieved, or as soon as it clearly cannot be.',
          inputSchema: FinalReportSchema,
          execute: async (r) => {
            report = r;
            return { ok: true };
          },
        }),
      };

      const instruction = [
        buildInstruction(test, resume, useHints ? hints : [], this.loggedIn),
        '',
        'How to work: call snapshot to read the page, act on elements by their ref (click, type, select, hover),',
        'and snapshot again only when you need refs from a changed page (an action already returns the URL and',
        'title). Several actions on the same page can use refs from one snapshot. Use screenshot only when the tree',
        'is not enough. Finish with the finish tool and an honest report; your report never decides the result.',
      ].join('\n');
      const model = this.model ?? resolveModel(this.cfg.model);
      const result = await generateText({
        model,
        system: instruction,
        messages: [{ role: 'user', content: 'Start: read the page, then work toward the goal.' }],
        tools,
        stopWhen: [stepCountIs(test.maxSteps ?? this.cfg.maxSteps), hasToolCall('finish')],
        // No prepareStep that rewrites history: models that think (claude-*-5-5) sign each thinking block
        // against everything before it, so an edited earlier message makes the API reject the call
        // ("Invalid signature in thinking block", seen on the first real run). The conversation is only ever
        // appended to; snapshots are kept small instead. No temperature either: thinking models ignore it.
      });
      ctx.logger.debug(`loop agent finished after ${result.steps.length} model step(s)`);

      /** @type {AgentClaim} */
      const claim = report
        ? {
            success: report.status === 'done',
            message: report.summary,
            status: report.status,
            observed: report.observed,
            ...(report.valuesUsed?.length ? { valuesUsed: report.valuesUsed } : {}),
          }
        : { success: false, message: 'Stopped at the step limit without a report.' };
      log({
        source: 'agent',
        tool: 'done',
        description: 'Finished',
        ok: true,
        observe: true,
        url: session.page.url(),
      });
      return {
        mode: 'agent',
        agentClaim: claim,
        steps: [...prior, ...steps.map((s, i) => ({ ...s, index: prior.length + i }))],
        recordable: recordable && claim.success,
        heals: [],
        baseline,
        trace,
        llmUsage: {
          inputTokens: result.totalUsage?.inputTokens ?? 0,
          outputTokens: result.totalUsage?.outputTokens ?? 0,
        },
        agentInput: { model: this.cfg.model, engine: 'loop', instruction },
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

/**
 * @param {string} description @param {string} selector @param {string} method @param {string[]} args
 * @param {number} [index]
 * @returns {RecordedStep}
 */
function actStep(description, selector, method, args, index = 0) {
  return { index, kind: 'act', description, selector, method, arguments: args };
}
