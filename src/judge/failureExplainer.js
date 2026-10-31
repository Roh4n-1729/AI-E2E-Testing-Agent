import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { testInsight } from '../reporter/insights.js';
import { clip, explainError } from '../util/explain.js';

/**
 * @import { LlmClient } from '../core/ports.js'
 * @import { Explanation, TestResult } from '../core/types.js'
 * @import { Logger } from '../util/logger.js'
 */

/**
 * After the verdict, one call per failed test reads the evidence and says what most likely went wrong, in
 * plain words. It runs only for tests that already failed, it is shown as "the AI's reading", and it never
 * changes a verdict: the judge decided from the evidence before this was asked (rule 2).
 *
 * The category is the useful part for triage: an app bug, a problem with the test itself (a check that
 * guessed wording, a step that clicked the wrong thing), the environment (a blocked network, a login), or
 * unclear. A failing test is not always a broken app, and saying so honestly is what makes the rest
 * believable.
 */

export const ExplanationSchema = z.object({
  cause: z
    .string()
    .describe(
      'One or two sentences in plain words for a non-developer: what most likely went wrong, as seen in the evidence.',
    ),
  category: z
    .enum(['app-bug', 'test-problem', 'environment', 'unclear'])
    .describe(
      'app-bug: the app does not do what it should. test-problem: the test itself is wrong (a check expects wording the app never shows, a step used the wrong control, the goal is ambiguous). environment: network, login, blocked third-party resources, timeouts unrelated to the app. unclear: the evidence does not say.',
    ),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z
    .array(z.string())
    .describe(
      'Up to 3 short observations from the material that support the cause, quoting the page text, a step or an error. Nothing that is not in the material.',
    ),
  suggestion: z
    .string()
    .describe(
      'One short next step for a person: what to fix or check (in the app, or in the test). Empty if there is none.',
    ),
});

const SYSTEM = `You explain why an automated end-to-end browser test failed, for a reader who is not a developer.
The verdict is final and was decided by deterministic checks on evidence the harness collected. Do not
re-judge it and never say the test passed. Your job is the most likely cause.
- Use only the material given: the checks that failed, the steps in order, the page text, console errors,
  failed requests and the screenshots (first = start, last = the end state the checks looked at).
- Prefer what a user would see on the screenshots and in the page text. Quote short phrases.
- Say plainly when the test itself looks wrong: a check that expects wording the app never shows, a step that
  used the wrong control, a goal that is ambiguous. That is "test-problem", not an app bug.
- If the evidence does not show a cause, say so and use "unclear" with low confidence. Do not guess.
- No selectors, XPath or stack traces in the cause. Short sentences.`;

/** Everything the explainer reads about one failed test, as text. @param {TestResult} r */
export function explainPrompt(r) {
  const t = testInsight(r);
  const steps = t.pages
    .filter((p) => p.status !== 'unreached')
    .flatMap((p) =>
      p.steps.map((s) => `${s.n}. [${p.name}] ${s.description}${s.ok ? '' : '  <- FAILED'}`),
    );
  const errors = r.evidence.console
    .filter((c) => c.type === 'error' || c.type === 'pageerror')
    .slice(0, 4)
    .map((c) => `- ${explainError(c.text)}`);
  const requests = r.evidence.networkFailures
    .slice(0, 4)
    .map((n) => `- ${n.method} ${n.url} -> ${n.status ?? n.failure ?? '?'}`);
  return [
    `Test: ${r.test.title}`,
    r.test.goal ? `Goal: ${r.test.goal}` : 'Goal: none (the test only checks the start page)',
    `Result: ${r.verdict.status}. How it ran: ${t.how}.`,
    r.verdict.status === 'error' ? `Error: ${clip(r.verdict.reason, 400)}` : '',
    '',
    'Checks that failed (expected -> what the harness found):',
    ...(t.reasons.length
      ? t.reasons.map((x) => `- ${x.expected} -> ${x.actual}`)
      : [`- ${clip(r.verdict.reason, 300)}`]),
    '',
    'Pages, in order:',
    t.pages.map((p) => `${p.name}${p.status === 'ok' ? '' : ` (${p.status})`}`).join(' -> ') ||
      '(none)',
    '',
    'Steps:',
    ...(steps.length ? steps : ['(none)']),
    t.failedStep ? `The failed step's error: ${clip(r.verdict.reason, 300)}` : '',
    r.agentClaim
      ? `The browser agent reported (not trusted): ${clip(r.agentClaim.message, 400)}`
      : '',
    '',
    `Final page: ${r.evidence.finalUrl} · title "${r.evidence.title}"`,
    `Final page text (first 2000 characters): ${clip(r.evidence.pageTextExcerpt, 2000) || '(none)'}`,
    errors.length ? `Console errors:\n${errors.join('\n')}` : 'Console errors: none',
    requests.length ? `Failed requests:\n${requests.join('\n')}` : 'Failed requests: none',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Start screenshot, the one right before the failed step (if any), and the end state; at most 3. */
function pickShots(/** @type {TestResult} */ r) {
  const shots = r.evidence.screenshots ?? [];
  const trace = r.trace ?? [];
  const bad = trace.findIndex((t) => !t.ok && !t.observe);
  const before = bad > 0 ? [...trace.slice(0, bad)].reverse().find((t) => t.screenshot) : undefined;
  const paths = [
    shots.find((s) => s.label === 'start')?.path ?? shots[0]?.path,
    before?.screenshot,
    [...shots].reverse().find((s) => s.label === 'final')?.path ?? shots.at(-1)?.path,
  ].filter(Boolean);
  return [...new Set(paths)];
}

export class FailureExplainer {
  /**
   * @param {LlmClient} llm  the judge's model
   * @param {string} runDir  where the screenshots are
   * @param {Logger} logger
   * @param {string} model  recorded with each explanation
   */
  constructor(llm, runDir, logger, model) {
    this.llm = llm;
    this.runDir = runDir;
    this.logger = logger;
    this.model = model;
  }

  /**
   * @param {TestResult} r
   * @returns {Promise<Explanation | undefined>} undefined when the test passed or the call failed
   */
  async explain(r) {
    if (r.verdict.status === 'pass') return undefined;
    try {
      /** @type {Uint8Array[]} */
      const images = [];
      for (const p of pickShots(r)) {
        const bytes = await readFile(path.join(this.runDir, /** @type {string} */ (p))).catch(
          () => undefined,
        );
        if (bytes) images.push(bytes);
      }
      const out = await this.llm.generateObject({
        schema: ExplanationSchema,
        system: SYSTEM,
        prompt: explainPrompt(r),
        images,
      });
      return {
        ...out,
        cause: clip(out.cause, 400),
        evidence: out.evidence.slice(0, 3).map((e) => clip(e, 200)),
        suggestion: clip(out.suggestion, 240),
        model: this.model,
      };
    } catch (e) {
      // advisory: a failed explanation must never cost the run its result
      this.logger.warn(
        `${r.test.id}: could not explain the failure (${/** @type {Error} */ (e).message})`,
      );
      return undefined;
    }
  }
}
