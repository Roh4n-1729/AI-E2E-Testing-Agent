import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CachedPlanner } from '../src/planner/cachedPlanner.js';
import { PLANNER_VERSION } from '../src/planner/llmPlanner.js';
import { createLogger } from '../src/util/logger.js';

const test = (/** @type {string} */ id) => ({
  id,
  title: id,
  goal: 'do it',
  startUrl: 'https://app.test/',
  expectations: [{ kind: /** @type {const} */ ('no-console-errors') }],
  tags: [],
});

describe('saved plans', () => {
  it('are reused for the same key, said so, and replaced when the key changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'plans-'));
    let calls = 0;
    const inner = { plan: async () => [test(`t${++calls}`)] };
    const target = { url: 'https://app.test/' };
    const site = /** @type {import('../src/core/types.js').SiteMap} */ (
      /** @type {unknown} */ ({ pages: [] })
    );
    const logger = createLogger('error');
    /** @type {number[]} */
    const reused = [];
    const make = (/** @type {string} */ key) =>
      new CachedPlanner(inner, dir, { replan: false, key, onReuse: (n) => reused.push(n) }, logger);

    expect((await make('v1').plan(target, site))[0].id).toBe('t1');
    expect((await make('v1').plan(target, site))[0].id).toBe('t1');
    expect(reused).toEqual([1]);
    // a new planner version (or model, or test count) plans again
    expect((await make('v2').plan(target, site))[0].id).toBe('t2');
    expect(calls).toBe(2);
  });

  it('has a planner version that follows the planner instructions', () => {
    expect(PLANNER_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });
});
