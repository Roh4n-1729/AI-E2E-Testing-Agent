import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** @param {string} p */
const posix = (p) => p.split(path.sep).join('/');

/** Run-level layout: <outDir>/runs/<runId>/{report.json, report.html, <testId>/...} */
export class RunArtifacts {
  /** @type {Map<string, TestArtifacts>} */
  #tests = new Map();
  /**
   * @param {string} outDir
   * @param {string} runId
   */
  constructor(outDir, runId) {
    this.runId = runId;
    this.runDir = path.resolve(outDir, 'runs', runId);
  }
  async init() {
    await mkdir(this.runDir, { recursive: true });
  }
  /**
   * One instance per test for the whole run: a second attempt (the agent re-checking a failed replay)
   * keeps numbering its files instead of overwriting the first attempt's screenshots.
   * @param {string} testId
   */
  forTest(testId) {
    let t = this.#tests.get(testId);
    if (!t) {
      t = new TestArtifacts(this.runDir, testId);
      this.#tests.set(testId, t);
    }
    return t;
  }
  /** @param {string} rel @param {unknown} data */
  async writeJson(rel, data) {
    return this.writeText(rel, JSON.stringify(data, null, 2));
  }
  /** @param {string} rel @param {string} content */
  async writeText(rel, content) {
    const abs = path.join(this.runDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return abs;
  }
}

/** Per-test files. Paths put in evidence are relative to the run dir, so reports are portable. */
export class TestArtifacts {
  #shot = 0;
  #dl = 0;
  #vis = 0;
  /**
   * @param {string} runDir
   * @param {string} testId
   */
  constructor(runDir, testId) {
    this.runDir = runDir;
    this.testId = testId;
    this.dir = path.join(runDir, testId);
  }
  async init() {
    await mkdir(path.join(this.dir, 'screenshots'), { recursive: true });
  }
  /** @param {string} label */
  nextScreenshot(label) {
    const safe = label.replace(/[^a-z0-9-]+/gi, '-').slice(0, 40);
    const name = `${String(++this.#shot).padStart(3, '0')}-${safe}.png`;
    const abs = path.join(this.dir, 'screenshots', name);
    return { abs, rel: posix(path.relative(this.runDir, abs)) };
  }
  /** A screenshot for visual comparison (separate from the step screenshots people look at). @param {string} checkpoint */
  async nextVisual(checkpoint) {
    const safe = checkpoint.replace(/[^a-z0-9-]+/gi, '-').slice(0, 60);
    const abs = path.join(
      this.dir,
      'visual',
      `${String(++this.#vis).padStart(3, '0')}-${safe}.png`,
    );
    await mkdir(path.dirname(abs), { recursive: true });
    return { abs, rel: posix(path.relative(this.runDir, abs)) };
  }
  /** Where a file the browser downloaded during this test is saved. @param {string} name */
  downloadPath(name) {
    const safe =
      path
        .basename(name)
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 120) || 'download';
    const abs = path.join(this.dir, 'downloads', `${++this.#dl}-${safe}`);
    return { abs, rel: posix(path.relative(this.runDir, abs)) };
  }
  /** @param {string} name @param {string} content */
  async writeText(name, content) {
    const abs = path.join(this.dir, name);
    await writeFile(abs, content);
    return { abs, rel: posix(path.relative(this.runDir, abs)) };
  }
}
