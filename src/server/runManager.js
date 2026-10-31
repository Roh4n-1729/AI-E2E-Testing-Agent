import { runInsights } from '../reporter/insights.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startRun } from '../app/startRun.js';
import { RunEvents } from '../events/runEvents.js';
import { newRunId } from '../util/misc.js';

/**
 * @import { RunOptions } from '../app/startRun.js'
 * @import { RunReport, RunSummary } from '../core/types.js'
 */

/**
 * @typedef {object} RunRecord
 * @property {string} runId
 * @property {'running' | 'done' | 'error' | 'stopped'} status
 * @property {string} startedAt
 * @property {RunOptions} options
 * @property {RunEvents} events
 * @property {AbortController} controller
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
    /** @type {RunRecord} */
    const record = {
      runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      options,
      events: new RunEvents(),
      controller: new AbortController(),
    };
    this.#runs.set(runId, record);
    // kept next to the report so "Run again" works after a restart
    const dir = path.join(this.outDir, 'runs', runId);
    mkdir(dir, { recursive: true })
      .then(() => writeFile(path.join(dir, 'options.json'), JSON.stringify(options, null, 2)))
      .catch(() => undefined);
    this.run(
      { ...options, runId, outDir: this.outDir },
      { events: record.events, signal: record.controller.signal },
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

  /** @param {string} runId @returns {boolean} true if a running run was asked to stop */
  stop(runId) {
    const r = this.#runs.get(runId);
    if (!r || r.status !== 'running') return false;
    r.controller.abort();
    return true;
  }

  /** In-memory runs plus every report on disk, newest first. @returns {Promise<RunListItem[]>} */
  async list() {
    /** @type {Map<string, RunListItem>} */
    const items = new Map();
    for (const dir of await safeReaddir(path.join(this.outDir, 'runs'))) {
      const report = await this.readReport(dir);
      if (report) {
        items.set(dir, {
          runId: dir,
          status: 'done',
          startedAt: report.startedAt,
          targetUrl: report.targetUrl,
          summary: report.summary,
          ...listFacts(report),
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
