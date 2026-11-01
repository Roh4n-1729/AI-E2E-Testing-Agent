import { applyStorageState } from '../auth/login.js';
import { QualityCollector } from './collectors.js';
import { launchBrowser } from './session.js';

/**
 * One browser window for a whole run, used when the browser is shown. Tests run one at a time in it, so a person
 * watching sees a single window, and can help in it when the agent asks (core/humanHelp.js).
 *
 * Isolation is kept by cleaning between tests instead of relaunching: the test gets a fresh tab (the old ones
 * close, taking their session storage with them), cookies and permissions are cleared, and every origin the run visited loses its storage (local and
 * session storage, IndexedDB, cache storage, service workers). A logged-in run then gets its saved session back.
 * Headless runs keep a fresh browser per test, the stronger isolation, since nobody is watching.
 *
 * @import { Browser, BrowserContext, Page } from 'playwright'
 * @import { Stagehand } from '@browserbasehq/stagehand'
 * @import { Config } from '../config/config.js'
 * @import { Logger } from '../util/logger.js'
 * @import { StorageState } from '../auth/login.js'
 */

export class BrowserHost {
  /** @type {Promise<{ stagehand: Stagehand, browser: Browser, context: BrowserContext, quality: QualityCollector }> | undefined} */
  #open;
  /** every origin a test's page has shown: its storage is cleared before the next test */
  #origins = new Set();
  closed = false;
  #loggedIn = false;
  /** tests that have used the window so far */
  uses = 0;

  /** @param {Config} cfg @param {Logger} logger */
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
  }

  /**
   * The shared browser, cleaned for the next test.
   * @param {{ storageState?: StorageState, downloadDir?: (name: string) => { abs: string, rel: string } }} opts
   */
  async acquire(opts) {
    if (this.closed) throw new Error('The shared browser was closed');
    const b = await (this.#open ??= this.#launch());
    await this.#clean(b, opts.storageState);
    b.quality.reset({ downloadDir: opts.downloadDir });
    this.uses++;
    return b;
  }

  async #launch() {
    const launched = await launchBrowser(this.cfg, this.logger);
    const quality = new QualityCollector();
    await quality.installOn(launched.context);
    const track = (/** @type {Page} */ p) =>
      p.on('framenavigated', (f) => {
        if (f !== p.mainFrame()) return;
        try {
          const o = new URL(f.url()).origin;
          if (o.startsWith('http')) this.#origins.add(o);
        } catch {
          /* about:blank, data: URLs */
        }
      });
    for (const p of launched.context.pages()) track(p);
    launched.context.on('page', track);
    return { ...launched, quality };
  }

  /**
   * @param {{ stagehand: Stagehand, context: BrowserContext }} b @param {StorageState} [storageState]
   */
  async #clean({ stagehand, context }, storageState) {
    const old = context.pages().filter((p) => !p.isClosed());
    // the first test gets the browser's own first tab, which is fresh; later tests get a new tab, because
    // sessionStorage and history belong to a tab, so the old ones are closed rather than reused
    const page = this.uses === 0 && old[0] ? old[0] : await context.newPage();
    for (const p of old) if (p !== page) await p.close().catch(() => undefined);
    // the AI's driver must be on the new tab too before the agent starts
    for (let i = 0; i < 40 && stagehand.context.pages().length !== 1; i++)
      await new Promise((r) => setTimeout(r, 50));
    await context.clearCookies();
    await context.clearPermissions().catch(() => undefined);
    if (this.#origins.size) {
      const cdp = await context.newCDPSession(page);
      for (const origin of this.#origins)
        await cdp
          .send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
          .catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
    if (!storageState) return;
    // the login's localStorage comes back through an init script registered once; cookies are re-added each time
    if (this.#loggedIn) await context.addCookies(storageState.cookies);
    else await applyStorageState(context, storageState);
    this.#loggedIn = true;
  }

  /** Close the window (end of the run, or Stop). */
  async close() {
    this.closed = true;
    const open = this.#open;
    this.#open = undefined;
    if (!open) return;
    const b = await open.catch(() => undefined);
    if (!b) return;
    await b.browser.close().catch(() => undefined);
    await b.stagehand.close().catch(() => undefined);
  }
}
