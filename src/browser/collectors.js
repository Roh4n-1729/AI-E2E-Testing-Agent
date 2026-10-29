import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * @import { BrowserContext, Download, Page, Request } from 'playwright'
 * @import { A11yResult, DownloadRecord, RequestRecord, RequestStats, SeenText, VitalMetric, VitalsRecord } from '../core/types.js'
 */

const require = createRequire(import.meta.url);

/** Read lazily and once: axe is ~650 kB and only needed when a test finishes. */
/** @type {string | undefined} */
let axeSource;
/** @type {string | undefined} */
let vitalsSource;
export const getAxe = () =>
  (axeSource ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));
const getVitals = () =>
  (vitalsSource ??= readFileSync(
    // web-vitals does not export its dist files, but its main entry sits in the same folder
    path.join(path.dirname(require.resolve('web-vitals')), 'web-vitals.iife.js'),
    'utf8',
  ));

const STATIC_TYPES = new Set(['image', 'font', 'stylesheet', 'media', 'script', 'manifest']);
const MAX_RECORDS = 400;
const MAX_SEEN = 200;

/**
 * Runs inside every page: reports Core Web Vitals (Google's `web-vitals`, Apache-2.0) to Node.
 * Wrapped in a function so the library's `var webVitals` never leaks into the app under test.
 */
export const vitalsInitScript = () => `(() => { try {
  ${getVitals()}
  const send = (m) => { try { window.__aie2eVital && window.__aie2eVital({ name: m.name, value: m.value, rating: m.rating, url: location.href }); } catch (_) {} };
  const o = { reportAllChanges: true };
  webVitals.onLCP(send, o); webVitals.onCLS(send, o); webVitals.onFCP(send, o);
  webVitals.onINP(send, o); webVitals.onTTFB(send, o);
} catch (_) { /* never break the app under test */ } })();`;

/**
 * Runs inside every page: reports text that APPEARS in toasts / alerts / live regions, even if it
 * is gone a second later (a "File downloaded" toast is invisible to an end-of-test screenshot).
 */
export const seenTextInitScript = `(() => { try {
  const seen = new Set();
  const TOASTY = /toast|snack|notif|alert|flash|banner/i;
  const live = (el) => {
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 6; n = n.parentElement, i++) {
      const role = n.getAttribute('role');
      if (role === 'status' || role === 'alert' || role === 'alertdialog' || role === 'log') return true;
      const al = n.getAttribute('aria-live');
      if (al && al !== 'off') return true;
      if (n.hasAttribute('data-sonner-toast') || n.hasAttribute('data-toast')) return true;
      const cls = typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '';
      if (TOASTY.test(cls) || (n.id && TOASTY.test(n.id))) return true;
    }
    return false;
  };
  const report = (raw) => {
    const text = String(raw || '').replace(/\\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 200 || seen.has(text) || seen.size >= ${MAX_SEEN}) return;
    seen.add(text);
    try { window.__aie2eSeen && window.__aie2eSeen({ text, url: location.href }); } catch (_) {}
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && live(n)) report(n.innerText || n.textContent);
        else if (n.nodeType === 3 && n.parentElement && live(n.parentElement)) report(n.textContent);
      }
      if (m.type === 'characterData' && m.target.parentElement && live(m.target.parentElement)) report(m.target.textContent);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
} catch (_) { /* never break the app under test */ } })();`;

/**
 * Collects QA signals no agent can influence: every fetch/XHR the page makes, downloads, transient
 * messages, Core Web Vitals, and (on demand) an axe-core accessibility scan.
 */
export class QualityCollector {
  /** @type {RequestRecord[]} */
  #requests = [];
  /** @type {Map<Request, RequestRecord>} */
  #open = new Map();
  #seq = 0;
  #total = 0;
  #failed = 0;
  #bytes = 0;
  /** @type {Record<string, number>} */
  #byType = {};
  /** @type {DownloadRecord[]} */
  #downloads = [];
  /** @type {SeenText[]} */
  #seen = [];
  /** @type {Map<string, Map<string, VitalMetric>>} document url -> metric name -> latest */
  #vitals = new Map();

  /**
   * @param {{ downloadDir?: (name: string) => { abs: string, rel: string } }} [opts]
   */
  constructor(opts = {}) {
    this.downloadPath = opts.downloadDir;
  }

  /** Context-level hooks: init scripts and the bindings they call. @param {BrowserContext} context */
  async installOn(context) {
    await context.exposeBinding('__aie2eVital', (_src, /** @type {any} */ v) => {
      if (!v || typeof v.value !== 'number') return;
      const byName = this.#vitals.get(v.url) ?? new Map();
      byName.set(v.name, { name: v.name, value: v.value, rating: v.rating });
      this.#vitals.set(v.url, byName);
    });
    await context.exposeBinding('__aie2eSeen', (_src, /** @type {any} */ v) => {
      if (!v?.text || this.#seen.length >= MAX_SEEN) return;
      this.#seen.push({
        text: String(v.text),
        url: String(v.url ?? ''),
        ts: new Date().toISOString(),
      });
    });
    await context.addInitScript(vitalsInitScript());
    await context.addInitScript(seenTextInitScript);
  }

  /** Per-page hooks. @param {Page} page */
  attach(page) {
    page.on('request', (r) => this.#onRequest(r));
    page.on('response', (r) => {
      const rec = this.#open.get(r.request());
      if (rec) rec.status = r.status();
    });
    page.on('requestfinished', (r) => void this.#onFinished(r));
    page.on('requestfailed', (r) => {
      const rec = this.#open.get(r);
      if (rec) rec.failure = r.failure()?.errorText ?? 'failed';
      this.#failed++;
      this.#open.delete(r);
    });
    page.on('download', (d) => void this.#onDownload(d));
  }

  /** fetch/XHR requests still waiting for a response (streaming AI responses count). */
  get inflightApi() {
    let n = 0;
    for (const r of this.#open.values()) if (r.api) n++;
    return n;
  }

  /** Number of requests seen so far (used to mark `api-call` expectations met before the agent acted). */
  get requestCount() {
    return this.#seq;
  }

  /** @param {Request} r */
  #onRequest(r) {
    const url = r.url();
    if (!/^https?:/.test(url)) return;
    const type = r.resourceType();
    this.#total++;
    this.#byType[type] = (this.#byType[type] ?? 0) + 1;
    const api = type === 'fetch' || type === 'xhr';
    const seq = ++this.#seq;
    if (STATIC_TYPES.has(type)) return; // counted, not listed
    /** @type {RequestRecord} */
    const rec = {
      seq,
      method: r.method(),
      url: url.slice(0, 300),
      resourceType: type,
      api,
      ts: new Date().toISOString(),
    };
    if (this.#requests.length < MAX_RECORDS) {
      this.#requests.push(rec);
      this.#open.set(r, rec);
    }
  }

  /** @param {Request} r */
  async #onFinished(r) {
    try {
      const sizes = await r.sizes();
      this.#bytes += Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize);
      const rec = this.#open.get(r);
      if (rec) {
        const t = r.timing();
        if (t.responseEnd >= 0) rec.durationMs = Math.round(t.responseEnd);
        rec.bytes = Math.max(0, sizes.responseBodySize);
      }
    } catch {
      /* the page closed first */
    } finally {
      this.#open.delete(r);
    }
  }

  /** @param {Download} d */
  async #onDownload(d) {
    /** @type {DownloadRecord} */
    const rec = {
      filename: d.suggestedFilename(),
      url: d.url().slice(0, 300),
      ts: new Date().toISOString(),
    };
    this.#downloads.push(rec);
    if (!this.downloadPath) return;
    try {
      const { abs, rel } = this.downloadPath(rec.filename);
      await d.saveAs(abs);
      rec.savedPath = rel;
      rec.bytes = statSync(abs).size;
      const failure = await d.failure();
      if (failure) rec.error = failure;
    } catch (e) {
      rec.error = String(e).split('\n')[0];
    }
  }

  /** @returns {RequestRecord[]} */
  get requests() {
    return [...this.#requests];
  }

  /** @returns {RequestStats} */
  stats() {
    const api = this.#requests.filter((r) => r.api);
    let slowest;
    for (const r of api) {
      if (r.durationMs !== undefined && (!slowest || r.durationMs > slowest.durationMs))
        slowest = { url: r.url, durationMs: r.durationMs };
    }
    return {
      total: this.#total,
      failed: this.#failed,
      api: api.length,
      transferredBytes: this.#bytes,
      byType: { ...this.#byType },
      slowestApi: slowest,
    };
  }

  get downloads() {
    return [...this.#downloads];
  }

  get seenText() {
    return [...this.#seen];
  }

  /** @returns {VitalsRecord[]} */
  vitals() {
    return [...this.#vitals.entries()].map(([url, m]) => ({ url, metrics: [...m.values()] }));
  }

  /**
   * axe-core scan of the page as it is now (WCAG 2.x A/AA rules).
   * @param {Page} page @returns {Promise<A11yResult>}
   */
  async scanA11y(page) {
    try {
      await page.evaluate(getAxe());
      return await page.evaluate(async () => {
        // @ts-expect-error axe is injected above
        const r = await window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
          resultTypes: ['violations'],
        });
        return {
          violations: r.violations.map((/** @type {any} */ v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            helpUrl: v.helpUrl,
            nodes: v.nodes.length,
            examples: v.nodes.slice(0, 3).map((/** @type {any} */ n) => ({
              target: n.target.join(' '),
              html: String(n.html ?? '').slice(0, 160),
            })),
          })),
        };
      });
    } catch (e) {
      return { violations: [], error: String(e).split('\n')[0] };
    }
  }
}
