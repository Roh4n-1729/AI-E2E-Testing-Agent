import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Stagehand } from '@browserbasehq/stagehand';
import { chromium } from 'playwright';
import { agentChromeArgs, resolveChromePath } from './chrome.js';
import { QualityCollector } from './collectors.js';
import { CURSOR_SCRIPT } from './cursor.js';
import { settle } from './settle.js';
import { auditThemes } from '../theme/audit.js';
import { ThemeStates, fingerprintOf } from '../theme/states.js';
import { applyTheme, discoverThemes, restoreTheme, themeState } from '../theme/discover.js';
import { applyStorageState } from '../auth/login.js';

/** Visual-comparison captures hide the harness's own cursor overlay: its position is not the app's. */
const VISUAL_STYLE = '#__aie2e_cursor{display:none!important}';
/**
 * ...and, by default, live regions: a toast from the previous step may or may not still be on screen
 * depending on timing (seen: "Added T-shirt" stacked behind "Added Notebook" in 1 of 5 runs).
 */
const LIVE_STYLE =
  '[role=status],[role=alert],[role=log],[role=timer],[role=marquee],[aria-live=polite],[aria-live=assertive]{visibility:hidden!important}';

/**
 * @import { Browser, BrowserContext, Page } from 'playwright'
 * @import { Config } from '../config/config.js'
 * @import { TestArtifacts } from '../storage/artifacts.js'
 * @import { Baseline, ConsoleEntry, Evidence, Expectation, NetworkFailure, ScreenshotRef, ThemeAudit, ThemeState, VisualCapture } from '../core/types.js'
 * @import { Logger } from '../util/logger.js'
 */

/**
 * One Chromium, two drivers:
 *  - Stagehand (AI: act / observe / agent) launches the browser.
 *  - Playwright attaches over CDP for everything deterministic: navigation, replay,
 *    and, crucially, evidence collection that the agent cannot influence.
 */
export class BrowserSession {
  /** @type {ConsoleEntry[]} */
  #consoleLog = [];
  /** @type {NetworkFailure[]} */
  #networkLog = [];
  /** @type {ScreenshotRef[]} */
  #screenshots = [];
  /** @type {((ref: ScreenshotRef) => void) | undefined} Called for every screenshot saved (harness or agent). */
  onScreenshot;
  /** @type {ThemeState[]} distinct screens of this test that were theme-audited, in order */
  #themeStates = [];
  #themeInBetween = 0;
  #noThemes = false;
  static #auditSeq = 0;
  /** @type {VisualCapture[]} */
  #visual = [];
  /** @type {'off' | 'warn' | 'fail'} visual regression gate; 'off' = no comparison captures */
  visualGate = 'off';
  hideLiveRegions = true;
  /** @type {import('../core/types.js').ThemeReference | undefined} audit against another product's themes */
  themeReference;

  /**
   * @param {Stagehand} stagehand
   * @param {Browser} browser
   * @param {BrowserContext} context
   * @param {TestArtifacts} artifacts
   * @param {QualityCollector} quality  API calls, downloads, transient text, web vitals, a11y.
   * @param {Config['quality']} qualityCfg
   * @param {ThemeStates} [themeStates]  run-wide: screens already audited by other tests are reused
   */
  constructor(stagehand, browser, context, artifacts, quality, qualityCfg, themeStates) {
    this.stagehand = stagehand;
    this.browser = browser;
    this.context = context;
    this.artifacts = artifacts;
    this.quality = quality;
    this.qualityCfg = qualityCfg;
    this.themeStates = themeStates ?? new ThemeStates({ perTest: qualityCfg.themeStates });
    for (const p of context.pages()) this.#attach(p);
    context.on('page', (p) => this.#attach(p));
  }

  /**
   * @param {Config} cfg
   * @param {TestArtifacts} artifacts
   * @param {Logger} logger
   * @param {{ themeStates?: ThemeStates, storageState?: import('../auth/login.js').StorageState, themeReference?: import('../core/types.js').ThemeReference }} [opts]
   */
  static async open(cfg, artifacts, logger, opts = {}) {
    await artifacts.init();
    const executablePath = resolveChromePath(cfg);
    logger.debug(`launching Chromium (${executablePath ?? 'system chrome'})`);
    const stagehand = new Stagehand({
      env: 'LOCAL',
      model: cfg.model,
      verbose: cfg.logLevel === 'debug' ? 2 : 0,
      disablePino: true,
      // Agent callbacks (onEvidence) are an experimental Stagehand feature that requires both flags.
      // Safe for env: 'LOCAL', which never uses the Browserbase API anyway.
      experimental: true,
      disableAPI: true,
      localBrowserLaunchOptions: {
        headless: cfg.headless,
        executablePath,
        args: agentChromeArgs(cfg),
        viewport: cfg.viewport,
      },
    });
    await stagehand.init();
    const browser = await chromium.connectOverCDP(stagehand.connectURL());
    const context = browser.contexts()[0];
    if (!context) {
      await stagehand.close().catch(() => undefined);
      throw new Error('Playwright attached over CDP but found no browser context');
    }
    context.setDefaultNavigationTimeout(cfg.navTimeoutMs);
    // logged-in runs: every test starts with the session the login produced (cookies + localStorage)
    if (opts.storageState) await applyStorageState(context, opts.storageState);
    const quality = new QualityCollector({ downloadDir: (n) => artifacts.downloadPath(n) });
    await quality.installOn(context);
    if (cfg.showCursor) {
      await context.addInitScript(CURSOR_SCRIPT);
      for (const p of context.pages()) await p.evaluate(CURSOR_SCRIPT).catch(() => undefined);
    }
    const session = new BrowserSession(
      stagehand,
      browser,
      context,
      artifacts,
      quality,
      cfg.quality,
      opts.themeStates,
    );
    session.visualGate = cfg.visual.gate;
    session.themeReference = opts.themeReference;
    session.hideLiveRegions = cfg.visual.hideLiveRegions;
    return session;
  }

  /** Most recently opened page that is still open (agents sometimes open new tabs). */
  get page() {
    const open = this.context.pages().filter((p) => !p.isClosed());
    const last = open[open.length - 1];
    if (!last) throw new Error('No open page');
    return last;
  }

  /**
   * Navigate and wait until the page has actually rendered. Screenshots and the baseline taken right
   * after this must show the real page: a blank capture makes every "already true at the start?"
   * comparison meaningless (seen on a real run: 6 of 9 start screenshots were blank).
   * @param {string} url
   */
  async goto(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
    await this.settle({ maxMs: 8000, quietMs: 500 });
  }

  /**
   * Wait for the app to go quiet (text stable, no aria-busy, no fetch/XHR in flight), capped.
   * @param {{ maxMs: number, quietMs: number }} o
   */
  settle(o) {
    return settle(this.page, o, () => this.quality.inflightApi);
  }

  /**
   * @param {string} label
   * @param {ScreenshotRef['source']} [source]
   */
  async screenshot(label, source = 'harness') {
    const { abs, rel } = this.artifacts.nextScreenshot(label);
    await this.page.screenshot({ path: abs, fullPage: false });
    /** @type {ScreenshotRef} */
    const ref = { label, path: rel, url: this.page.url(), source };
    this.#screenshots.push(ref);
    this.onScreenshot?.(ref);
    return ref;
  }

  /**
   * Persist a screenshot captured elsewhere (e.g. the agent's own frames).
   * @param {string} label @param {Uint8Array} bytes @param {string} url
   */
  async saveScreenshotBytes(label, bytes, url) {
    const { abs, rel } = this.artifacts.nextScreenshot(label);
    await writeFile(abs, bytes);
    /** @type {ScreenshotRef} */
    const ref = { label, path: rel, url, source: 'agent' };
    this.#screenshots.push(ref);
    this.onScreenshot?.(ref);
    return ref;
  }

  /** Absolute path of a screenshot ref (refs are relative to the run dir). @param {ScreenshotRef} ref */
  absPath(ref) {
    return path.join(this.artifacts.runDir, ref.path);
  }

  /**
   * Stream the front tab to a UI as smooth video (CDP screencast: Chromium pushes a JPEG every time
   * the page repaints, so the gliding cursor and animations look continuous instead of 4 fps).
   * Costs nothing while nobody watches: the screencast only runs while `shouldCapture()` is true.
   * It follows the front tab when the agent opens a new one, and re-sends the last frame every
   * ~1.5 s so a viewer who joins while the page is idle still sees it.
   * @param {(jpeg: Buffer) => void} onFrame @param {() => boolean} shouldCapture
   * @param {{ quality?: number, maxFps?: number }} [opts]
   * @returns {() => void} stop
   */
  startLiveView(onFrame, shouldCapture, { quality = 60, maxFps = 30 } = {}) {
    const minGap = 1000 / maxFps;
    let stopped = false;
    /** @type {import('playwright').CDPSession | undefined} */
    let cdp;
    /** @type {Page | undefined} */
    let castPage;
    /** @type {Buffer | undefined} */
    let lastFrame;
    /** @type {Buffer | undefined} */
    let pending;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let flushTimer;
    let lastSent = 0;

    const send = (/** @type {Buffer} */ jpeg) => {
      lastSent = Date.now();
      lastFrame = jpeg;
      onFrame(jpeg);
    };
    // Throttle to maxFps but never drop the LAST frame of a burst (it shows the final state).
    const offer = (/** @type {Buffer} */ jpeg) => {
      lastFrame = jpeg;
      const wait = minGap - (Date.now() - lastSent);
      if (wait <= 0) return send(jpeg);
      pending = jpeg;
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        if (pending && !stopped && shouldCapture()) send(pending);
        pending = undefined;
      }, wait);
    };
    const stopCast = async () => {
      const c = cdp;
      cdp = undefined;
      castPage = undefined;
      if (!c) return;
      await c.send('Page.stopScreencast').catch(() => undefined);
      await c.detach().catch(() => undefined);
    };
    const startCast = async (/** @type {Page} */ page) => {
      const c = await this.context.newCDPSession(page);
      c.on('Page.screencastFrame', (f) => {
        c.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
        if (shouldCapture()) offer(Buffer.from(f.data, 'base64'));
      });
      const vp = page.viewportSize() ?? { width: 1280, height: 800 };
      await c.send('Page.startScreencast', {
        format: 'jpeg',
        quality,
        maxWidth: vp.width,
        maxHeight: vp.height,
        everyNthFrame: 1,
      });
      cdp = c;
      castPage = page;
      // the screencast only speaks when the page changes: show the current state right away
      const first = await page
        .screenshot({ type: 'jpeg', quality, timeout: 2000 })
        .catch(() => undefined);
      if (first && shouldCapture()) send(first);
    };

    (async () => {
      while (!stopped) {
        try {
          if (!shouldCapture()) {
            if (cdp) await stopCast();
          } else {
            const page = this.page;
            if (!cdp || castPage !== page) {
              await stopCast();
              await startCast(page);
            } else if (lastFrame && Date.now() - lastSent > 1500) {
              send(lastFrame); // idle page: keep a late-joining viewer supplied
            }
          }
        } catch {
          await stopCast(); // tab closed or navigating: try again on the next tick
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      await stopCast();
    })();
    return () => {
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
    };
  }

  /**
   * Snapshot of the page as it is NOW, taken by the harness before the agent acts. The judge uses
   * it to tell expectations that were already true (proving nothing) from real state changes.
   * @param {Expectation[]} expectations
   * @returns {Promise<Baseline>}
   */
  async baseline(expectations) {
    const page = this.page;
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    /** @type {string[]} */
    const visibleSelectors = [];
    for (const e of expectations) {
      if (e.kind !== 'selector-visible') continue;
      if (
        (await page
          .locator(e.selector)
          .filter({ visible: true })
          .count()
          .catch(() => 0)) > 0
      ) {
        visibleSelectors.push(e.selector);
      }
    }
    return {
      url: page.url(),
      text: text.toLowerCase(),
      visibleSelectors,
      requestCount: this.quality.requestCount,
    };
  }

  /**
   * A deterministic screenshot for visual regression: animations finished, caret hidden, the harness
   * cursor hidden, and every [data-aie2e-mask] area painted over (timestamps, AI-written text...).
   * @param {string} checkpoint  stable name the baseline is stored under
   * @param {string} label  for people
   * @param {string} [theme]
   * @returns {Promise<VisualCapture | null>}
   */
  async visualCapture(checkpoint, label, theme) {
    if (this.visualGate === 'off') return null;
    const page = this.page;
    const { abs, rel } = await this.artifacts.nextVisual(checkpoint);
    const ok = await page
      .screenshot({
        path: abs,
        animations: 'disabled',
        caret: 'hide',
        mask: [page.locator('[data-aie2e-mask]')],
        maskColor: '#8a8f98',
        style: this.hideLiveRegions ? `${VISUAL_STYLE}${LIVE_STYLE}` : VISUAL_STYLE,
      })
      .then(() => true)
      .catch(() => false);
    if (!ok) return null;
    /** @type {VisualCapture} */
    const cap = { checkpoint, label, path: rel, url: page.url(), theme };
    this.#visual.push(cap);
    return cap;
  }

  /** The final screen once per theme the build ships, so a dark-only regression is caught too. */
  async #visualThemes() {
    const page = this.page;
    const d = await discoverThemes(page).catch(() => null);
    if (!d || d.themes.length < 2 || !d.tokenNames.length) return;
    const original = await themeState(page);
    try {
      for (const t of d.themes) {
        await applyTheme(page, t, d.themes);
        await this.visualCapture(`theme-${t.id}`, `final · ${t.id}`, t.id);
      }
    } finally {
      await restoreTheme(page, original).catch(() => undefined);
    }
  }

  get #themeOn() {
    return this.qualityCfg.theme && this.qualityCfg.gate !== 'off';
  }

  /**
   * Theme-audit the screen the test is on now, if this run has not audited it yet. Called by the
   * executors between steps (the agent is paused while this runs) and by collectEvidence for the final
   * state. In-between audits are capped per test and skipped once the build turned out to ship no themes.
   * @param {string} label  "start", "after step 3", "final"
   * @param {{ step?: number, final?: boolean }} [o]
   * @returns {Promise<ThemeState | null>}
   */
  async auditState(label, { step, final = false } = {}) {
    if (!this.#themeOn) return null;
    if (!final && (this.#noThemes || this.#themeInBetween >= this.themeStates.perTest)) return null;
    const page = this.page;
    /** @param {string | null} k */
    const knownAs = (k) => this.#themeStates.find((st) => st.key === k);
    let key = await fingerprintOf(page);
    if (!key) return null;
    if (knownAs(key)) return knownAs(key) ?? null; // this test already covered this screen (cheap: no wait)
    if (!final) {
      // a new screen: let it finish rendering, then make sure it is still the same new screen
      await this.settle({ maxMs: 3000, quietMs: 400 });
      key = await fingerprintOf(page);
      if (!key) return null;
      if (knownAs(key)) return knownAs(key) ?? null;
    }
    if (!final) this.#themeInBetween++;
    const dir = path.join(
      this.artifacts.dir,
      'theme',
      `${++BrowserSession.#auditSeq}-${label.replace(/[^\w]+/g, '-')}`,
    );
    const state = await this.themeStates.visit(
      key,
      { testId: this.artifacts.testId, label, url: page.url(), step, final },
      () =>
        auditThemes(page, {
          dir,
          rel: (abs) => path.relative(this.artifacts.runDir, abs).split(path.sep).join('/'),
          scrollSafe: !final,
          reference: this.themeReference,
        }).catch(
          (e) =>
            /** @type {ThemeAudit} */ ({
              themes: [],
              tokenCount: 0,
              skippedSheets: [],
              error: String(e).split('\n')[0],
            }),
        ),
    );
    if (!state) return null;
    if (!state.audit.themes.length && !state.audit.error) this.#noThemes = true;
    this.#themeStates.push(state);
    return state;
  }

  /**
   * Independent evidence snapshot. Never consults the agent.
   * @param {string} [label]
   * @returns {Promise<Evidence>}
   */
  async collectEvidence(label = 'final') {
    // AI apps keep streaming after the agent stops: judge the page once it has gone quiet
    await this.settle({ maxMs: 15_000, quietMs: 1000 });
    await this.screenshot(label);
    const page = this.page;
    /** @type {string | undefined} */
    let aria;
    try {
      aria = await page.locator('body').ariaSnapshot({ timeout: 5000 });
    } catch {
      /* best effort */
    }
    const ariaRef = aria ? await this.artifacts.writeText(`aria-${label}.txt`, aria) : undefined;
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const theme = this.#themeOn
      ? (await this.auditState('final', { final: true }))?.audit
      : undefined;
    if (this.visualGate !== 'off') {
      await this.visualCapture('final', 'final');
      await this.#visualThemes().catch(() => undefined);
    }
    return {
      finalUrl: page.url(),
      title: await page.title().catch(() => ''),
      ariaSnapshotPath: ariaRef?.rel,
      pageTextExcerpt: text.slice(0, 2000),
      screenshots: [...this.#screenshots],
      console: [...this.#consoleLog],
      networkFailures: [...this.#networkLog],
      requests: this.quality.requests,
      requestStats: this.quality.stats(),
      downloads: this.quality.downloads,
      seenText: this.quality.seenText,
      vitals: this.quality.vitals(),
      theme,
      themeStates: this.#themeOn ? [...this.#themeStates] : undefined,
      visual: this.visualGate !== 'off' ? { captures: [...this.#visual] } : undefined,
      a11y:
        this.qualityCfg.a11y && this.qualityCfg.gate !== 'off'
          ? await this.quality.scanA11y(page)
          : undefined,
    };
  }

  async close() {
    await this.browser.close().catch(() => undefined);
    await this.stagehand.close().catch(() => undefined);
  }

  /** @param {Page} page */
  #attach(page) {
    this.quality.attach(page);
    const ts = () => new Date().toISOString();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        this.#consoleLog.push({
          type: m.type(),
          text: m.text(),
          url: m.location().url || page.url(),
          ts: ts(),
        });
      }
    });
    page.on('pageerror', (e) =>
      this.#consoleLog.push({ type: 'pageerror', text: e.message, url: page.url(), ts: ts() }),
    );
    page.on('requestfailed', (r) =>
      this.#networkLog.push({
        url: r.url(),
        method: r.method(),
        failure: r.failure()?.errorText,
        ts: ts(),
      }),
    );
    page.on('response', (r) => {
      if (r.status() >= 400) {
        this.#networkLog.push({
          url: r.url(),
          method: r.request().method(),
          status: r.status(),
          ts: ts(),
        });
      }
    });
  }
}
