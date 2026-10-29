import { slugify } from '../util/misc.js';

/**
 * @import { Planner } from '../core/ports.js'
 * @import { Expectation, SiteMap, Target, TestCase } from '../core/types.js'
 */

/**
 * Builds exactly one test from what the user supplied on the command line.
 * No goal -> a deterministic smoke test (no LLM).
 * @implements {Planner}
 */
export class StaticPlanner {
  /** @param {Target} target @param {SiteMap} _siteMap @returns {Promise<TestCase[]>} */
  async plan(target, _siteMap) {
    /** @type {Expectation[]} */
    const expectations = [];
    if (target.expectUrl)
      expectations.push({ kind: 'url', pattern: target.expectUrl, mode: 'includes' });
    for (const text of target.expectText ?? []) expectations.push({ kind: 'text-visible', text });
    expectations.push({ kind: 'no-console-errors' }, { kind: 'no-network-failures' });

    const goal = target.goal?.trim() ?? '';
    return [
      {
        id: goal ? slugify(goal) : 'smoke',
        title: goal || 'Smoke: page loads without errors',
        goal,
        startUrl: target.url,
        expectations,
        tags: goal ? [] : ['smoke'],
      },
    ];
  }
}
