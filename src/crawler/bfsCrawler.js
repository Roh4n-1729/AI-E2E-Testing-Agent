import { chromium } from 'playwright';
import { resolveChromePath } from '../browser/chrome.js';
import { readHints } from '../browser/hints.js';
import { errorMessage } from '../util/misc.js';

/**
 * @import { Config } from '../config/config.js'
 * @import { Crawler } from '../core/ports.js'
 * @import { SitePage, SiteMap, Target } from '../core/types.js'
 * @import { Logger } from '../util/logger.js'
 */

/** Links we never follow: they change state or end the session. */
const UNSAFE_LINK = /log-?out|sign-?out|delete|remove|unsubscribe|destroy|deactivate|cancel/i;
const ASSET_EXT = /\.(pdf|png|jpe?g|gif|svg|webp|ico|zip|gz|mp4|mp3|css|js|json|xml|woff2?)$/i;

/**
 * Normalise for de-duplication: drop the hash, keep the query.
 * @param {string} href @param {string} base
 * @returns {string | null}
 */
export function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * @param {string} url @param {string} text @param {string} origin
 */
export function isSafeLink(url, text, origin) {
  const u = new URL(url);
  if (u.origin !== origin) return false;
  if (ASSET_EXT.test(u.pathname)) return false;
  return !UNSAFE_LINK.test(u.pathname + u.search) && !UNSAFE_LINK.test(text);
}

/**
 * Lean crawler: capped BFS, same-origin, skips logout/delete-style links. Its only job is to
 * give the planner a map of what the app contains.
 * @implements {Crawler}
 */
export class BfsCrawler {
  /**
   * @param {Config} cfg @param {Logger} logger
   * @param {{ storageState?: import('../auth/login.js').StorageState }} [o]  explore logged in
   */
  constructor(cfg, logger, o = {}) {
    this.cfg = cfg;
    this.logger = logger;
    this.storageState = o.storageState;
  }

  /** @param {Target} target @returns {Promise<SiteMap>} */
  async crawl(target) {
    const { maxPages, maxDepth } = this.cfg.crawl;
    const start = normalizeUrl(target.url, target.url) ?? target.url;
    const origin = new URL(start).origin;
    const browser = await chromium.launch({
      executablePath: resolveChromePath(this.cfg),
      args: this.cfg.chromeArgs,
      headless: true,
    });
    /** @type {SitePage[]} */
    const pages = [];
    try {
      const context = await browser.newContext({
        viewport: this.cfg.viewport,
        storageState: this.storageState,
      });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(this.cfg.navTimeoutMs);
      const seen = new Set([start]);
      const queue = [{ url: start, depth: 0 }];
      while (queue.length && pages.length < maxPages) {
        const { url, depth } = /** @type {{ url: string, depth: number }} */ (queue.shift());
        /** @type {Set<string>} */
        const apiCalls = new Set();
        /** @param {import('playwright').Response} r */
        const onResponse = (r) => {
          const t = r.request().resourceType();
          if ((t === 'fetch' || t === 'xhr') && apiCalls.size < 12)
            apiCalls.add(`${r.request().method()} ${new URL(r.url()).pathname}`);
        };
        page.on('response', onResponse);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
          const raw = await readPage(page);
          const hints = await readHints(page);
          /** @type {string[]} */
          const links = [];
          for (const a of raw.anchors) {
            const link = normalizeUrl(a.href, url);
            if (!link || !isSafeLink(link, a.text, origin) || links.includes(link)) continue;
            links.push(link);
            if (depth < maxDepth && !seen.has(link)) {
              seen.add(link);
              queue.push({ url: link, depth: depth + 1 });
            }
          }
          pages.push({
            url,
            title: raw.title,
            links: links.slice(0, 30),
            textExcerpt: raw.text,
            forms: raw.forms,
            buttons: raw.buttons,
            inputs: [...new Set(raw.inputs)],
            apiCalls: [...apiCalls],
            testIds: hints
              .filter((h) => h.selector)
              .slice(0, 40)
              .map((h) => `${h.selector} "${h.text}"${h.visible ? '' : ' (hidden)'}`),
            hints: hints
              .flatMap((h) => (h.hint ? [`${h.selector ?? h.tag}: ${h.hint}`] : []))
              .slice(0, 15),
          });
        } catch (e) {
          const msg = errorMessage(e);
          // Links to downloads (no file extension) are expected and not worth a warning.
          if (msg.includes('Download is starting'))
            this.logger.debug(`crawl: ${url} is a download`);
          else this.logger.warn(`crawl: skipped ${url}: ${msg.split('\n')[0]}`);
        } finally {
          page.off('response', onResponse);
        }
      }
    } finally {
      await browser.close();
    }
    this.logger.info(`Crawled ${pages.length} page(s)`);
    return { origin, pages };
  }
}

/**
 * What a page offers, read in the page: title, text, forms, text boxes, buttons and links.
 * @param {import('playwright').Page} page
 */
export function readPage(page) {
  return page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1500),
    forms: document.forms.length,
    inputs: [
      ...document.querySelectorAll(
        'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [role="textbox"]',
      ),
    ]
      .map((el) =>
        (
          el.getAttribute('placeholder') ||
          el.getAttribute('aria-label') ||
          (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
          el.getAttribute('name') ||
          ''
        ).trim(),
      )
      .filter(Boolean)
      .slice(0, 12),
    buttons: [...document.querySelectorAll('button, [role="button"]')]
      .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 20),
    anchors: [...document.querySelectorAll('a[href]')].map((a) => ({
      href: /** @type {HTMLAnchorElement} */ (a).href,
      text: (a.textContent ?? '').trim(),
    })),
  }));
}

/**
 * Open one URL in a fresh browser (logged in when the run is) and read what it shows, after the page has gone
 * quiet. Exploring deeper uses it to see whether a screen a test reached opens directly by its address.
 * @param {Config} cfg @param {string} url
 * @param {{ storageState?: import('../auth/login.js').StorageState }} [o]
 * @returns {Promise<import('../core/discovery.js').Snapshot | null>}
 */
export async function probePage(cfg, url, o = {}) {
  const browser = await chromium.launch({
    executablePath: resolveChromePath(cfg),
    args: cfg.chromeArgs,
    headless: true,
  });
  try {
    const context = await browser.newContext({
      viewport: cfg.viewport,
      storageState: o.storageState,
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(cfg.navTimeoutMs);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    const raw = await readPage(page);
    return { url: page.url(), title: raw.title, text: raw.text, buttons: raw.buttons };
  } catch {
    return null;
  } finally {
    await browser.close();
  }
}
