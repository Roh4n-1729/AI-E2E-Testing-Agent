import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SuiteSchema } from '../planner/suitePlanner.js';

/** Suite names are file names: lowercase, digits and dashes. */
export const SUITE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Test suites people author in the UI: plain JSON files (`<name>.suite.json`), the same format as
 * `--suite` and `aie2e export`. Point AIE2E_SUITES_DIR into the repo to review and commit them.
 */
export class SuiteStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  /** @param {string} name */
  file(name) {
    if (!SUITE_NAME.test(name))
      throw new Error('Suite names use lowercase letters, digits and dashes');
    return path.join(this.dir, `${name}.suite.json`);
  }

  async list() {
    /** @type {{ name: string, url?: string, description?: string, tests: number, recorded: number, updatedAt: string }[]} */
    const out = [];
    let names = [];
    try {
      names = (await readdir(this.dir)).filter((f) => f.endsWith('.suite.json'));
    } catch {
      return out;
    }
    for (const f of names) {
      const name = f.replace(/\.suite\.json$/, '');
      try {
        const suite = await this.get(name);
        out.push({
          name,
          url: suite.url,
          description: suite.description,
          tests: suite.tests.length,
          recorded: suite.tests.filter((t) => t.steps?.length).length,
          updatedAt: (await stat(this.file(name))).mtime.toISOString(),
        });
      } catch {
        /* an invalid file is skipped, not fatal */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** @param {string} name */
  async get(name) {
    return SuiteSchema.parse(JSON.parse(await readFile(this.file(name), 'utf8')));
  }

  /**
   * Validate and save. Returns the issues instead of throwing, so the UI can show them next to the form.
   * @param {string} name @param {unknown} body
   */
  async save(name, body) {
    const parsed = SuiteSchema.safeParse(body);
    if (!parsed.success)
      return {
        ok: /** @type {const} */ (false),
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(name), `${JSON.stringify(parsed.data, null, 2)}\n`);
    return { ok: /** @type {const} */ (true), suite: parsed.data };
  }

  /** @param {string} name */
  async remove(name) {
    await rm(this.file(name), { force: true });
  }
}
