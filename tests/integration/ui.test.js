import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/app.js';
import { hasChromium, startApp } from './harness.js';

const uiDir = path.resolve('ui/dist');
const built = existsSync(path.join(uiDir, 'index.html'));

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let target;
/** @type {Awaited<ReturnType<typeof createServer>>['app']} */
let app;
/** @type {import('playwright').Browser} */
let browser;
let ui = '';

beforeAll(async () => {
  if (!hasChromium || !built) return;
  target = /** @type {typeof target} */ (await startApp());
  ({ app } = await createServer({
    outDir: mkdtempSync(path.join(os.tmpdir(), 'aie2e-ui-')),
    uiDir,
  }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  ui = `http://127.0.0.1:${/** @type {any} */ (app.server.address()).port}`;
  browser = await chromium.launch({
    executablePath: process.env.AIE2E_CHROME_PATH,
    args: process.env.AIE2E_CHROME_ARGS?.split(' '),
  });
});
afterAll(async () => {
  await browser?.close();
  await app?.close();
  target?.server.close();
});

describe.skipIf(!hasChromium || !built)('web UI (real browser; needs `npm run ui:build`)', () => {
  it('starts a run from the form, shows live progress, then the results with report links', async () => {
    const page = await browser.newPage();
    const errors = /** @type {string[]} */ ([]);
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${ui}/#/new`);
    await page.getByPlaceholder('https://your-app.example.com').fill(target.base);
    await page.getByRole('radio', { name: /Smoke check/ }).click(); // no LLM needed
    await page.getByRole('button', { name: /start testing/i }).click();

    await page.waitForURL(/#\/runs\//);
    const runId = new URL(page.url()).hash.split('/')[2];
    // finished: the plain-English verdict, the tests table and the report link
    const html = page.getByRole('link', { name: /^Report/ });
    await html.waitFor({ timeout: 30_000 });
    await page.getByText('The flow works', { exact: true }).waitFor();
    const href = await html.getAttribute('href');
    expect(href).toMatch(/^\/files\/runs\/.+\/report\.html$/);
    expect((await page.request.get(ui + href)).status()).toBe(200);
    await page
      .getByRole('table')
      .getByRole('link', { name: 'Smoke: page loads without errors' })
      .click();
    // the test as a journey: pages, steps, why it passed; the developer evidence one click away
    await page.waitForURL(/#\/runs\/.+\/tests\/smoke/);
    await page
      .getByRole('heading', { name: 'Smoke: page loads without errors', level: 1 })
      .waitFor();
    await page.getByText('Why it passed').waitFor();
    // screenshots open in the viewer, not a new tab
    await page
      .getByRole('button', { name: /Open screenshot:/ })
      .first()
      .click();
    await page.locator('.yarl__root').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Developer details' }).click();
    await page.getByRole('tab', { name: /Quality/ }).click();
    await page.getByText('Core Web Vitals').waitFor();

    // history lists it
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Runs', exact: true })
      .click();
    await page.locator(`a[href="#/runs/${runId}"]`).first().waitFor();
    expect(errors).toEqual([]);
    await page.close();
  });

  it('writes a test suite in the UI, saves it as a file and runs it', async () => {
    const page = await browser.newPage();
    const errors = /** @type {string[]} */ ([]);
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${ui}/#/suites`);
    await page.getByText('No suites yet').waitFor();
    await page.getByRole('button', { name: 'New suite' }).first().click();
    await page.getByLabel('Suite name').fill('shop-smoke');
    await page.getByPlaceholder('https://staging.your-app.com').fill(target.base);
    await page.getByLabel('Test 1 title').fill('Shop page shows its heading');
    await page.getByPlaceholder('/', { exact: true }).fill('/shop');
    await page.getByRole('button', { name: '+ Add a check' }).click();
    await page.getByPlaceholder('Text, e.g. Order placed').fill('Shop');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL(/#\/suites\/shop-smoke$/);
    await page.getByText('Saved', { exact: false }).first().waitFor();

    // the file is the same format the CLI runs
    const saved = await (await page.request.get(`${ui}/api/suites/shop-smoke`)).json();
    expect(saved.suite.tests[0]).toMatchObject({
      title: 'Shop page shows its heading',
      startUrl: '/shop',
      expectations: [{ kind: 'text-visible', text: 'Shop' }],
    });

    await page.getByRole('button', { name: 'Run suite' }).click();
    await page.waitForURL(/#\/runs\//);
    await page.getByRole('link', { name: /^Report/ }).waitFor({ timeout: 45_000 });
    await page
      .getByRole('table')
      .getByRole('link', { name: 'Shop page shows its heading' })
      .waitFor();
    await page.getByText('The flow works', { exact: true }).waitFor();
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows a helpful empty state for recordings', async () => {
    const page = await browser.newPage();
    await page.goto(`${ui}/#/recordings`);
    await page.getByText('No recordings yet').waitFor();
    await page.close();
  });
});
