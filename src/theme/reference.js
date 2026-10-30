import { chromium } from 'playwright';
import { resolveChromePath } from '../browser/chrome.js';
import { settle } from '../browser/settle.js';
import { resolveTokens } from './audit.js';
import { applyTheme, discoverThemes } from './discover.js';

/**
 * @import { Config } from '../config/config.js'
 * @import { ThemeReference } from '../core/types.js'
 * @import { Logger } from '../util/logger.js'
 */

/**
 * Read another product's themes (every theme it ships, with every token resolved to a real value) so
 * this run can check its own app against them: "how close are all our products to one theme".
 * Values are compared, not variable names: two products rarely name their tokens the same way.
 * @param {{ url: string, cfg: Config, logger: Logger }} o
 * @returns {Promise<ThemeReference>}
 */
export async function captureReference({ url, cfg, logger }) {
  const browser = await chromium.launch({
    executablePath: resolveChromePath(cfg),
    args: cfg.chromeArgs,
    headless: true,
  });
  try {
    const page = await (await browser.newContext({ viewport: cfg.viewport })).newPage();
    page.setDefaultNavigationTimeout(cfg.navTimeoutMs);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
    await settle(page, { maxMs: 8000, quietMs: 500 });
    const d = await discoverThemes(page);
    if (!d.themes.length || !d.tokenNames.length)
      throw new Error(
        `No theme variables found at ${url}: the reference product must define its theme as CSS custom properties`,
      );
    /** @type {ThemeReference['themes']} */
    const themes = [];
    for (const t of d.themes) {
      await applyTheme(page, t, d.themes);
      themes.push({ id: t.id, tokens: await page.evaluate(resolveTokens, d.tokenNames) });
    }
    logger.info(
      `Reference theme from ${url}: ${themes.map((t) => t.id).join(', ')} (${d.tokenNames.length} tokens)`,
    );
    return { url, themes };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
