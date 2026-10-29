/** @import { Crawler } from '../core/ports.js' */

/**
 * Single-page "crawl" with no browser (used by `--no-crawl` and tests).
 * @implements {Crawler}
 */
export class NoopCrawler {
  /** @param {import('../core/types.js').Target} target */
  async crawl(target) {
    const url = new URL(target.url);
    return { origin: url.origin, pages: [{ url: target.url, title: '', links: [] }] };
  }
}
