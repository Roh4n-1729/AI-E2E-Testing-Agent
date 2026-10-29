/**
 * @import { RecordedStep } from '../core/types.js'
 */

/** Agent tools that observe or finish but do not change the page: safe to leave out of a recording. */
const NON_MUTATING = new Set([
  'screenshot',
  'ariaTree',
  'extract',
  'think',
  'scroll',
  'done',
  'search',
  'fillForm', // its concrete field actions arrive as separate `act` entries
  'appTestIds',
]);

/** Round to 1 decimal: viewport percentages need no more precision. @param {number} n */
const pct = (n) => String(Math.round(n * 10) / 10);

/**
 * Convert Stagehand agent actions (`AgentResult.actions`) into replayable steps.
 * Only `act` steps that carry a concrete selector (`playwrightArguments`), `goto`, `navback` and
 * `wait` are replayable. An unknown page-changing tool makes the whole recording unusable
 * (`recordable: false`), because a partial recording would replay wrongly.
 *
 * @param {ReadonlyArray<Record<string, any>>} actions
 * @param {number} startIndex  Index of the first new step.
 * @param {ReadonlyMap<string, string>} [stable]  XPath -> test-id/id selector found while recording.
 * @returns {{ steps: RecordedStep[], recordable: boolean }}
 */
export function actionsToSteps(actions, startIndex, stable = new Map()) {
  /** @type {RecordedStep[]} */
  const steps = [];
  let recordable = true;
  for (const a of actions) {
    const index = startIndex + steps.length;
    if (a.type === 'act') {
      const pa = a.playwrightArguments;
      if (pa && typeof pa.selector === 'string' && pa.selector) {
        const better = stable.get(pa.selector);
        steps.push({
          index,
          kind: 'act',
          description: String(pa.description ?? a.action ?? a.instruction ?? 'act'),
          selector: better ?? pa.selector,
          ...(better ? { fallbackSelectors: [pa.selector] } : {}),
          method: String(pa.method ?? 'click'),
          arguments: Array.isArray(pa.arguments) ? pa.arguments.map(String) : [],
        });
      }
      // an act without a selector failed or did nothing: leave it out
    } else if (a.type === 'goto' && typeof a.url === 'string') {
      steps.push({ index, kind: 'navigate', description: `Open ${a.url}`, url: a.url });
    } else if (a.type === 'hoverAt' && Number.isFinite(a.xPercent) && Number.isFinite(a.yPercent)) {
      steps.push({
        index,
        kind: 'mouse',
        description: `Hover at ${pct(a.xPercent)}%, ${pct(a.yPercent)}%${a.why ? ` (${String(a.why).slice(0, 80)})` : ''}`,
        arguments: [pct(a.xPercent), pct(a.yPercent)],
      });
    } else if (a.type === 'useTestId' && typeof a.selector === 'string') {
      if (a.ok === false) continue; // the tool refused or failed: nothing happened
      steps.push({
        index,
        kind: 'act',
        description: `${a.action} ${a.selector}`,
        selector: a.selector,
        method: String(a.action ?? 'click'),
        arguments: a.value !== undefined ? [String(a.value)] : [],
      });
    } else if (a.type === 'navback') {
      steps.push({ index, kind: 'back', description: 'Go back' });
    } else if (a.type === 'wait') {
      const ms = Number(a.timeMs ?? a.time ?? 1000);
      steps.push({ index, kind: 'wait', description: `Wait ${ms}ms`, arguments: [String(ms)] });
    } else if (!NON_MUTATING.has(String(a.type))) {
      recordable = false;
    }
  }
  if (!steps.some((s) => s.kind === 'act')) recordable = false;
  return { steps, recordable };
}

/** Renumber steps 0..n-1. @param {RecordedStep[]} steps @returns {RecordedStep[]} */
export function reindex(steps) {
  return steps.map((s, i) => ({ ...s, index: i }));
}
