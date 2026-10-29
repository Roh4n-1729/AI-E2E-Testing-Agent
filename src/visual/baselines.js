import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} BaselineMeta
 * @property {string} approvedAt
 * @property {string} runId  the run whose screenshot became the baseline
 * @property {string} fingerprint  of the test definition; a changed test starts a new baseline
 * @property {'first-pass' | 'approved' | 'update'} how
 */

/** File-system friendly name. @param {string} s */
const safe = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 80);

/**
 * Checkpoint name of a replayed step: its index plus a short hash of what it does, so a healed recording
 * that does something else at step 3 gets a new baseline instead of a false difference.
 * @param {{ index: number, description: string, selector?: string }} step
 */
export const stepCheckpoint = (step) =>
  `step-${step.index}-${createHash('sha1')
    .update(`${step.description}|${step.selector ?? ''}`)
    .digest('hex')
    .slice(0, 6)}`;

/**
 * Approved screenshots, one folder per app (origin) and test:
 *   <dir>/<host-port>/<testId>/<checkpoint>.png  +  baselines.json (who approved what, when).
 * Commit the folder (AIE2E_BASELINES_DIR) to review visual changes in pull requests.
 */
export class BaselineStore {
  /** @param {string} dir @param {string} appUrl */
  constructor(dir, appUrl) {
    let host = appUrl;
    try {
      host = new URL(appUrl).host;
    } catch {
      /* keep as given */
    }
    this.root = path.join(dir, safe(host));
  }

  /** @param {string} testId */
  #manifest(testId) {
    return path.join(this.root, safe(testId), 'baselines.json');
  }

  /** @param {string} testId @returns {Promise<Record<string, BaselineMeta>>} */
  async #read(testId) {
    try {
      return JSON.parse(await readFile(this.#manifest(testId), 'utf8'));
    } catch {
      return {};
    }
  }

  /** @param {string} testId @param {string} checkpoint */
  file(testId, checkpoint) {
    return path.join(this.root, safe(testId), `${safe(checkpoint)}.png`);
  }

  /**
   * @param {string} testId @param {string} checkpoint
   * @returns {Promise<{ path: string, meta: BaselineMeta } | null>}
   */
  async get(testId, checkpoint) {
    const meta = (await this.#read(testId))[checkpoint];
    return meta ? { path: this.file(testId, checkpoint), meta } : null;
  }

  /**
   * Make a screenshot the approved baseline.
   * @param {string} testId @param {string} checkpoint @param {string} fromAbs
   * @param {Omit<BaselineMeta, 'approvedAt'>} meta
   */
  async save(testId, checkpoint, fromAbs, meta) {
    const dest = this.file(testId, checkpoint);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(fromAbs, dest);
    const all = await this.#read(testId);
    all[checkpoint] = { ...meta, approvedAt: new Date().toISOString() };
    await writeFile(this.#manifest(testId), JSON.stringify(all, null, 2));
    return dest;
  }
}
