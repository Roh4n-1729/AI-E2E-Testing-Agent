/**
 * Typed run-event bus. The pipeline, runner and executors EMIT events; the CLI, the UI server (SSE)
 * and any future consumer SUBSCRIBE. Nothing outside this file knows how events are delivered, and
 * the UI never reaches into pipeline internals: it only sees these events.
 *
 * Event types and payloads:
 *   run.started    { runId, target: {url, description?, goal?}, config: {model, concurrency, headless, cache} }
 *   phase          { phase: 'crawl'|'plan'|'run'|'report', status: 'running'|'done', detail? }
 *   plan.ready     { tests: [{ id, title, goal, expectations }] }
 *   test.started   { testId, title, goal }
 *   test.step      { testId, source: 'agent'|'replay', description, ok? }
 *   test.screenshot{ testId, path, url, source: 'agent'|'harness' }
 *   test.finished  { testId, title, status, reason, mode, durationMs, claimMismatch, heals, llmUsage? }
 *   log            { level, scope, message }
 *   run.finished   { runId, summary }
 *   run.error      { message }
 *   frame          { testId, jpeg }   live browser view; high volume, NOT kept in history
 *
 * @typedef {{ seq: number, ts: string, type: string, data: Record<string, any> }} RunEvent
 */

const MAX_HISTORY = 5000;

export class RunEvents {
  /** @type {Set<(e: RunEvent) => void>} */
  #listeners = new Set();
  /** @type {RunEvent[]} */
  #history = [];
  #seq = 0;
  #liveViewers = 0;

  /** Number of clients currently watching the live browser view (frames are only captured if > 0). */
  get liveViewers() {
    return this.#liveViewers;
  }

  /** @param {number} delta */
  adjustLiveViewers(delta) {
    this.#liveViewers = Math.max(0, this.#liveViewers + delta);
  }

  /** @param {string} type @param {Record<string, any>} [data] @returns {RunEvent} */
  emit(type, data = {}) {
    /** @type {RunEvent} */
    const event = { seq: ++this.#seq, ts: new Date().toISOString(), type, data };
    if (type !== 'frame') {
      this.#history.push(event);
      if (this.#history.length > MAX_HISTORY) this.#history.shift();
    }
    for (const fn of this.#listeners) {
      try {
        fn(event);
      } catch {
        /* one bad listener must never break a run */
      }
    }
    return event;
  }

  /**
   * @param {(e: RunEvent) => void} fn
   * @param {{ replay?: boolean }} [opts]  replay: first deliver everything emitted so far
   * @returns {() => void} unsubscribe
   */
  subscribe(fn, { replay = true } = {}) {
    if (replay) for (const e of this.#history) fn(e);
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Everything emitted so far (without frames). */
  get history() {
    return [...this.#history];
  }
}

/** Do-nothing bus for callers that don't care (tests, simple scripts). */
export const nullEvents = new RunEvents();
