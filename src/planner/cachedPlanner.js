import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TestCaseSchema } from '../core/types.js';
import { sha256 } from '../util/misc.js';

/**
 * @import { Planner } from '../core/ports.js'
 * @import { SiteMap, Target, TestCase } from '../core/types.js'
 * @import { Logger } from '../util/logger.js'
 */

const PlanFileSchema = z.object({ tests: z.array(TestCaseSchema) });

/**
 * LLM plans differ run to run, which would make every run record fresh tests and never replay.
 * This decorator pins the plan per (url, description, key) so reruns reuse the same tests and their
 * recordings; the key holds maxTests and the planner's model and version, so a changed planner plans
 * again. `replan` forces a fresh plan.
 * @implements {Planner}
 */
export class CachedPlanner {
  /**
   * @param {Planner} inner @param {string} dir
   * @param {{ replan: boolean, key: string, onReuse?: (tests: number) => void }} opts
   *   key: anything that changes the plan; onReuse: tells the live UI a saved plan is used
   * @param {Logger} logger
   */
  constructor(inner, dir, opts, logger) {
    this.inner = inner;
    this.dir = path.resolve(dir);
    this.opts = opts;
    this.logger = logger;
  }

  /** @param {Target} target @param {SiteMap} siteMap @returns {Promise<TestCase[]>} */
  async plan(target, siteMap) {
    const file = path.join(
      this.dir,
      `${sha256(JSON.stringify([target.url, target.description ?? '', this.opts.key])).slice(0, 16)}.json`,
    );
    if (!this.opts.replan) {
      try {
        const { tests } = PlanFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
        this.logger.info(
          `Reusing the saved plan (${tests.length} tests) from an earlier run. Use --replan (Plan again) for a new one.`,
        );
        this.opts.onReuse?.(tests.length);
        return tests;
      } catch {
        /* no usable saved plan */
      }
    }
    const tests = await this.inner.plan(target, siteMap);
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, JSON.stringify({ tests }, null, 2));
    return tests;
  }
}
