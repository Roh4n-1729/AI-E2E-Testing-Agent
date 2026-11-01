import { z } from 'zod';

/**
 * @import { LlmClient } from '../core/ports.js'
 * @import { TestResult } from '../core/types.js'
 */

/**
 * "Apply the suggested fix": when the AI's reading says a test failed because of how it was written, propose a
 * better GOAL, the instructions the agent follows. Never the checks: they decide what counts as success, and a
 * fixer that could loosen them would turn real regressions into passes. A person reviews the proposal and saves
 * it; the old recording is then thrown away, because the goal is part of the test's identity.
 */

/** A check in a few words, for the prompt. @param {import('../core/types.js').Expectation} x */
const checkWords = (x) =>
  x.label ??
  (x.kind === 'visual'
    ? x.question
    : x.kind === 'text-visible' || x.kind === 'text-appeared'
      ? `"${x.text}" is shown`
      : x.kind === 'url'
        ? `the URL contains ${x.pattern}`
        : x.kind === 'selector-visible'
          ? `${x.selector} is visible`
          : x.kind);

export const GoalFixSchema = z.object({
  goal: z
    .string()
    .describe(
      'The rewritten goal: plain-English instructions an agent follows from the start page, naming controls by their visible label and where they are.',
    ),
  changed: z
    .string()
    .describe(
      'One sentence for the person reviewing it: what is different from the old goal, and why.',
    ),
});

const SYSTEM = `You rewrite the goal of an automated end-to-end browser test that failed because of how the test was
written, not because the app is broken. An agent follows the goal like a user; deterministic checks then decide
pass or fail, and you cannot change them.
- Keep the same intent: the checks below must still be the right way to tell whether it worked.
- Say how to do it: name the control by its visible label or placeholder and where it is ("type the request into
  the chat box on the right, labelled Ask AI, and send it"), using what the reading and the page show.
- Keep the test values the old goal gave (names, emails, topics).
- One short paragraph. No selectors or XPath.`;

/**
 * Whether this result can get a goal fix: a test with a goal that failed and the AI's reading blamed on the test,
 * or that passed only on a second try.
 * @param {TestResult} r
 */
export const canFixGoal = (r) =>
  !!r.test.goal.trim() &&
  ((r.verdict.status === 'fail' && r.explanation?.category === 'test-problem') ||
    !!r.retry?.passed);

/**
 * @param {LlmClient} llm @param {TestResult} r
 * @returns {Promise<z.infer<typeof GoalFixSchema>>}
 */
export async function proposeGoal(llm, r) {
  const e = r.explanation;
  const prompt = [
    `Test: ${r.test.title}`,
    `Old goal: ${r.test.goal}`,
    `Checks (fixed, you cannot change them): ${r.test.expectations
      .filter((x) => x.kind !== 'no-console-errors' && x.kind !== 'no-network-failures')
      .map(checkWords)
      .join('; ')}`,
    e ? `Why it failed (an AI's reading of the evidence): ${e.cause}` : '',
    e?.suggestion ? `Suggested next step: ${e.suggestion}` : '',
    r.retry?.passed ? `A second try passed when told: ${r.retry.hint}` : '',
    r.evidence.screen?.inputs?.length
      ? `Text boxes on the last screen: ${r.evidence.screen.inputs.join(' | ')}`
      : '',
    r.evidence.screen?.buttons?.length
      ? `Buttons on the last screen: ${r.evidence.screen.buttons
          .filter((b) => b.length <= 40)
          .slice(0, 20)
          .join(' | ')}`
      : '',
    `Page text at the end: ${r.evidence.pageTextExcerpt.replace(/\s+/g, ' ').slice(0, 800)}`,
  ]
    .filter(Boolean)
    .join('\n');
  return llm.generateObject({ schema: GoalFixSchema, system: SYSTEM, prompt });
}
