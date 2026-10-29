import { chromium } from 'playwright';
import { z } from 'zod';
import { resolveChromePath } from '../browser/chrome.js';
import { settle } from '../browser/settle.js';
import { RecordedStepSchema } from '../core/types.js';
import { runStep } from '../executor/replayExecutor.js';

/**
 * @import { BrowserContext, Page } from 'playwright'
 * @import { Config } from '../config/config.js'
 * @import { Logger } from '../util/logger.js'
 */

/**
 * How to log in before the tests run. Credentials are NEVER part of this object: they are read from
 * environment variables (.env) at login time, so suites and reports can be committed and shared.
 */
export const AuthSchema = z.object({
  /** the login page, absolute or relative to the app URL */
  loginUrl: z.string().min(1),
  usernameEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .default('AIE2E_USERNAME'),
  passwordEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .default('AIE2E_PASSWORD'),
  /** login succeeded when the URL contains this... */
  successUrl: z.string().optional(),
  /** ...or this text is visible. Default: the password field is gone and the URL changed. */
  successText: z.string().optional(),
  /**
   * Exact steps for unusual logins (SSO pickers, extra screens): replayed like recorded steps, with
   * {{username}} and {{password}} replaced in their arguments.
   */
  steps: z.array(RecordedStepSchema.omit({ index: true })).optional(),
});
/** @typedef {z.infer<typeof AuthSchema>} Auth */
/** @typedef {Awaited<ReturnType<BrowserContext['storageState']>>} StorageState */

export class LoginError extends Error {
  /** @param {string} message @param {string} [screenshot] */
  constructor(message, screenshot) {
    super(message);
    this.name = 'LoginError';
    this.screenshot = screenshot;
  }
}

const USER_FIELD = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[type="text"]',
].join(', ');
const SUBMIT =
  'button[type="submit"], input[type="submit"], button:text-matches("^\\\\s*(log ?in|sign ?in|continue|next|submit)\\\\s*$", "i")';

/** First visible match, or null. @param {Page} page @param {string} selector */
async function visible(page, selector) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  return (await loc.count()) ? loc : null;
}

/**
 * Log in once and return the browser storage (cookies + localStorage) every test then starts with.
 * Plain Playwright, no AI: the agent never sees the credentials.
 * @param {{ appUrl: string, auth: Auth, cfg: Config, logger: Logger, screenshot?: string }} o
 * @returns {Promise<{ state: StorageState, username: string, landedOn: string }>}
 */
export async function performLogin({ appUrl, auth, cfg, logger, screenshot }) {
  const username = process.env[auth.usernameEnv];
  const password = process.env[auth.passwordEnv];
  if (!username || !password)
    throw new LoginError(
      `Login needs ${auth.usernameEnv} and ${auth.passwordEnv}: add them to .env (they are never stored in suites or reports)`,
    );
  const loginUrl = new URL(auth.loginUrl, appUrl).toString();
  const browser = await chromium.launch({
    executablePath: resolveChromePath(cfg),
    args: cfg.chromeArgs,
    headless: true,
  });
  try {
    const context = await browser.newContext({ viewport: cfg.viewport });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(cfg.navTimeoutMs);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await settle(page, { maxMs: 8000, quietMs: 500 });
    const fill = (/** @type {string} */ v) =>
      v.replaceAll('{{username}}', username).replaceAll('{{password}}', password);

    if (auth.steps?.length) {
      for (const [i, s] of auth.steps.entries()) {
        await runStep(page, {
          ...s,
          index: i + 1,
          arguments: s.arguments?.map(fill),
          // hand-written login steps use CSS; recorded steps default to XPath
          selector:
            s.selector && !/^(xpath=|css=|text=|\/|\()/.test(s.selector)
              ? `css=${s.selector}`
              : s.selector,
        });
        await settle(page, { maxMs: 4000, quietMs: 400 });
      }
    } else {
      // The common shapes: one form, or "email, Next, then password" on a second screen.
      const user = await visible(page, USER_FIELD);
      if (user) await user.fill(username);
      let pass = await visible(page, 'input[type="password"]');
      if (!pass && user) {
        await (await visible(page, SUBMIT))?.click();
        await page
          .locator('input[type="password"]')
          .filter({ visible: true })
          .first()
          .waitFor({ timeout: 8000 })
          .catch(() => undefined);
        pass = await visible(page, 'input[type="password"]');
      }
      if (!pass)
        throw new LoginError(
          `No password field on ${loginUrl}. If this login has extra screens, give the exact steps in "auth.steps".`,
        );
      await pass.fill(password);
      const submit = await visible(page, SUBMIT);
      if (submit) await submit.click();
      else await pass.press('Enter');
    }
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
    await settle(page, { maxMs: 10_000, quietMs: 800 });

    const landedOn = page.url();
    const ok = auth.successText
      ? await page
          .getByText(auth.successText)
          .filter({ visible: true })
          .first()
          .waitFor({ timeout: 5000 })
          .then(() => true)
          .catch(() => false)
      : auth.successUrl
        ? landedOn.includes(auth.successUrl)
        : !(await visible(page, 'input[type="password"]')) && landedOn !== loginUrl;
    if (!ok) {
      if (screenshot) await page.screenshot({ path: screenshot }).catch(() => undefined);
      const why = auth.successText
        ? `"${auth.successText}" did not appear`
        : auth.successUrl
          ? `the URL is ${landedOn}, expected it to contain ${auth.successUrl}`
          : 'the login form is still there';
      throw new LoginError(`Login as ${username} failed: ${why}`, screenshot);
    }
    logger.info(`Logged in as ${username} (landed on ${landedOn})`);
    return { state: await context.storageState(), username, landedOn };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Start an existing context logged in: cookies now, localStorage before any page script runs.
 * (Stagehand owns the browser it launches, so Playwright's `newContext({ storageState })` is not an option.)
 * @param {BrowserContext} context @param {StorageState} state
 */
export async function applyStorageState(context, state) {
  if (state.cookies.length) await context.addCookies(state.cookies);
  const origins = state.origins.filter((o) => o.localStorage.length);
  if (!origins.length) return;
  await context.addInitScript((list) => {
    const mine = list.find((o) => o.origin === location.origin);
    if (!mine) return;
    try {
      for (const { name, value } of mine.localStorage)
        if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
    } catch {
      /* storage blocked: nothing to restore */
    }
  }, origins);
}
