import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RecordingSchema } from '../core/types.js';
import { sha256 } from '../util/misc.js';

/**
 * @import { RecordStore } from '../core/ports.js'
 * @import { Recording, TestCase } from '../core/types.js'
 */

/**
 * Identity of a test for caching: any change to what is tested invalidates its recording.
 * @param {TestCase} test
 */
export function testFingerprint(test) {
  // labels are words for people: rewording one must not throw a recording away
  const checks = test.expectations.map(({ label: _label, ...e }) => e);
  // a test that starts on a screen reached by earlier steps changes when those steps change; tests without
  // a prefix keep the fingerprint they always had, so existing recordings stay valid
  const prefix = test.prefix?.map((s) => [s.kind, s.url, s.selector, s.method, s.arguments]);
  return sha256(
    JSON.stringify(
      prefix ? [test.goal, test.startUrl, checks, prefix] : [test.goal, test.startUrl, checks],
    ),
  );
}

/**
 * Recordings live OUTSIDE per-run folders (<outDir>/recordings/<testId>.json) so later runs find them.
 * They are plain, reviewable JSON: commit them next to your tests if you like.
 * @implements {RecordStore}
 */
export class FileRecordStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  /** @param {string} testId */
  #file(testId) {
    return path.join(this.dir, `${testId}.json`);
  }

  /** @param {string} testId @returns {Promise<Recording | null>} */
  async load(testId) {
    try {
      const raw = JSON.parse(await readFile(this.#file(testId), 'utf8'));
      return RecordingSchema.parse(raw);
    } catch {
      return null; // missing or corrupt: treat as "no recording"
    }
  }

  /** @param {Recording} recording */
  async save(recording) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.#file(recording.testId), JSON.stringify(recording, null, 2));
  }
}
