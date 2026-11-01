import { runInsights } from '../reporter/insights.js';
import { appKey, compareRuns, digestOf, otherSuite, previousOf } from '../reporter/compare.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startRun } from '../app/startRun.js';
import { RunEvents } from '../events/runEvents.js';
import { HumanHelp } from '../core/humanHelp.js';
import { newRunId } from '../util/misc.js';

/**
 * @import { RunOptions } from '../app/startRun.js'
 * @import { RunReport, RunSummary } from '../core/types.js'
 * @import { RunDigest } from '../reporter/compare.js'
 */

/** Bump when the digest's shape changes: older digest files are rebuilt from their report. */
const DIGEST_VERSION = 3;

/** @typedef {RunDigest & { v: number, summary: RunSummary, facts: ReturnType<typeof listFacts> }} StoredDigest */

/**
 * @typedef {object} RunRecord
 * @property {string} runId
 * @property {'running' | 'done' | 'error' | 'stopped'} status
 * @property {string} startedAt
 * @property {RunOptions} options
 * @property {RunEvents} events
 * @property {AbortController} controller
 * @property {HumanHelp} help  answers the agent's requests for a person (only possible with the browser shown)
 * @property {RunReport} [report]
 * @property {string} [error]
 */

/**
 * @typedef {object} RunListItem
 * @property {string} runId
 * @property {'running' | 'done' | 'error' | 'stopped'} status
 * @property {string} startedAt
 * @property {string} targetUrl
 * @property {RunSummary} [summary]
 * @property {string} [headline]  plain-English verdict ("4 problems found"), from runInsights
 * @property {string} [app]  the app's own name when every page agrees on it
 * @property {string} [username]  who the run logged in as
 */

/**
 * Owns the runs started from the UI: one at a time (each test launches its own Chromium),
 * streams their events, supports Stop, and lists history from disk (`<out>/runs/<id>/report.json`).
 */
export class RunManager {
  /** @type {Map<string, RunRecord>} */
  #runs = new Map();

  /** @param {{ outDir: string, run?: typeof startRun }} deps */
  constructor({ outDir, run = startRun }) {
    this.outDir = path.resolve(outDir);
    this.run = run;
  }

  /** The run that is currently executing, if any. */
  get active() {
    return [...this.#runs.values()].find((r) => r.status === 'running');
  }

  /** @param {RunOptions} options @returns {RunRecord} */
  start(options) {
    if (this.active) throw new Error('A run is already in progress');
    const runId = newRunId();
    const events = new RunEvents();
    /** @type {RunRecord} */
    const record = {
      runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      options,
      events,
      controller: new AbortController(),
      // the person at this machine can act in the shown browser and answer from the UI
      help: new HumanHelp({ available: !!options.headed, events }),
    };
    this.#runs.set(runId, record);
    // kept next to the report so "Run again" works after a restart
    const dir = path.join(this.outDir, 'runs', runId);
    mkdir(dir, { recursive: true })
      .then(() => writeFile(path.join(dir, 'options.json'), JSON.stringify(options, null, 2)))
      .catch(() => undefined);
    this.run(
      { ...options, runId, outDir: this.outDir },
      { events: record.events, signal: record.controller.signal, help: record.help },
    )
      .then(({ report }) => {
        record.report = report;
        record.status = record.controller.signal.aborted ? 'stopped' : 'done';
      })
      .catch((e) => {
        record.error = e instanceof Error ? e.message : String(e);
        record.status = record.controller.signal.aborted ? 'stopped' : 'error';
      });
    return record;
  }

  /** @param {string} runId */
  get(runId) {
    return this.#runs.get(runId);
  }

  /**
   * A person's answer to the agent's request for help, from the UI.
   * @param {string} runId @param {string} testId @param {'done' | 'skipped'} answer @param {string} [note]
   * @returns {boolean} false when that test is not waiting
   */
  help(runId, testId, answer, note) {
    const r = this.#runs.get(runId);
    return !!r && r.status === 'running' && r.help.answer(testId, answer, note);
  }

  /** @param {string} runId @returns {boolean} true if a running run was asked to stop */
  stop(runId) {
    const r = this.#runs.get(runId);
    if (!r || r.status !== 'running') return false;
    r.controller.abort();
    return true;
  }

  /**
   * A finished run's digest (`<out>/runs/<id>/digest.json`, a few KB): what the run list, comparison and history
   * need, without reading the full report (often over a megabyte) every time. Built from the report the first time.
   * @param {string} runId @returns {Promise<StoredDigest | null>}
   */
  async digest(runId) {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) return null;
    const file = path.join(this.outDir, 'runs', runId, 'digest.json');
    try {
      const d = JSON.parse(await readFile(file, 'utf8'));
      if (d.v === DIGEST_VERSION) return d;
    } catch {
      /* not built yet */
    }
    const report = this.#runs.get(runId)?.report ?? (await this.readReport(runId));
    if (!report) return null;
    try {
      const options = await this.readOptions(runId);
      /** @type {StoredDigest} */
      const d = {
        v: DIGEST_VERSION,
        ...digestOf(
          report,
          options?.suiteName ??
            (options?.suite
              ? path.basename(String(options.suite)).replace(/\.suite\.json$|\.json$/, '')
              : undefined),
        ),
        summary: report.summary,
        facts: listFacts(report),
      };
      await writeFile(file, JSON.stringify(d)).catch(() => undefined);
      return d;
    } catch {
      return null; // an old or partial report must never break the list
    }
  }

  /** Every finished run's digest. @returns {Promise<StoredDigest[]>} */
  async digests() {
    /** @type {StoredDigest[]} */
    const out = [];
    for (const dir of await safeReaddir(path.join(this.outDir, 'runs'))) {
      const d = await this.digest(dir);
      if (d) out.push(d);
    }
    return out;
  }

  /**
   * This run against another (by default the latest earlier run on the same app, with the same suite).
   * @param {string} runId @param {string} [withId]
   */
  async compare(runId, withId) {
    const current = await this.digest(runId);
    if (!current) return null;
    const all = await this.digests();
    const previous = /** @type {StoredDigest | null} */ (
      withId ? await this.digest(withId) : previousOf(current, all)
    );
    const brief = (/** @type {StoredDigest} */ d) => ({
      runId: d.runId,
      targetUrl: d.targetUrl,
      startedAt: d.startedAt,
      headline: d.headline,
      suite: d.suite,
      stopped: d.stopped,
    });
    return {
      current: brief(current),
      previous: previous ? { ...brief(previous), otherSuite: otherSuite(current, previous) } : null,
      comparison: previous ? compareRuns(current, previous) : null,
      // other runs of this app, newest first, to compare with instead
      others: all
        .filter((d) => d.runId !== runId && appKey(d.targetUrl) === appKey(current.targetUrl))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 20)
        .map(brief),
    };
  }

  /** The app's runs over time (same app and suite), oldest first, for the trend. @param {string} runId */
  async history(runId) {
    const current = await this.digest(runId);
    if (!current) return null;
    return (await this.digests())
      .filter(
        (d) =>
          appKey(d.targetUrl) === appKey(current.targetUrl) &&
          (d.suite ?? '') === (current.suite ?? ''),
      )
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(-30)
      .map((d) => ({
        runId: d.runId,
        startedAt: d.startedAt,
        passed: d.totals.passed,
        total: d.totals.total,
        tokens: d.totals.tokens,
        durationMs: d.totals.durationMs,
        stopped: !!d.stopped,
      }));
  }

  /** In-memory runs plus every finished run on disk, newest first. @returns {Promise<RunListItem[]>} */
  async list() {
    /** @type {Map<string, RunListItem>} */
    const items = new Map();
    for (const dir of await safeReaddir(path.join(this.outDir, 'runs'))) {
      const d = this.#runs.get(dir)?.status === 'running' ? null : await this.digest(dir);
      if (d) {
        items.set(dir, {
          runId: dir,
          status: 'done',
          startedAt: d.startedAt,
          targetUrl: d.targetUrl,
          summary: d.summary,
          ...d.facts,
        });
      }
    }
    for (const r of this.#runs.values()) {
      items.set(r.runId, {
        runId: r.runId,
        status: r.status,
        startedAt: r.startedAt,
        targetUrl: r.options.url,
        summary: r.report?.summary ?? items.get(r.runId)?.summary,
        ...(r.report ? listFacts(r.report) : {}),
      });
    }
    return [...items.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Options a run was started with from the UI (absent for CLI runs). @param {string} runId */
  async readOptions(runId) {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) return undefined;
    try {
      return /** @type {RunOptions} */ (
        JSON.parse(await readFile(path.join(this.outDir, 'runs', runId, 'options.json'), 'utf8'))
      );
    } catch {
      return undefined;
    }
  }

  /** @param {string} runId @returns {Promise<RunReport | null>} */
  async readReport(runId) {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) return null;
    try {
      return JSON.parse(
        await readFile(path.join(this.outDir, 'runs', runId, 'report.json'), 'utf8'),
      );
    } catch {
      return null;
    }
  }
}

/** @param {string} dir */
async function safeReaddir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** What the run list shows about a finished run, beyond its numbers. @param {RunReport} report */
function listFacts(report) {
  const titles = new Set(report.results.map((r) => r.evidence.title?.trim()).filter(Boolean));
  let headline;
  try {
    headline = runInsights(report).headline;
  } catch {
    headline = undefined; // an old or partial report must never break the list
  }
  return {
    headline,
    app: titles.size === 1 ? [...titles][0] : undefined,
    username: report.auth?.username,
  };
}
