#!/usr/bin/env node
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { chromium } from 'playwright';
import { resolveChromePath } from '../browser/chrome.js';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRun } from '../app/startRun.js';
import { agentModelWarning, apiKeyEnvFor, loadConfig } from '../config/config.js';

const program = new Command()
  .name('aie2e')
  .description('AI-agent-driven E2E testing: plan, execute, strictly judge, report')
  .version('0.2.0');

program
  .command('run')
  .argument('<url>', 'URL of the app to test')
  .option('-g, --goal <text>', 'test exactly this flow, in plain English (skips the AI planner)')
  .option('-d, --description <text>', 'what the app is (context for the planner)')
  .option('--no-plan', 'no AI planner: run a deterministic smoke test only (needs no API key)')
  .option('--no-crawl', 'skip crawling; plan from the start URL only')
  .option('--max-tests <n>', 'max AI-planned tests', Number)
  .option('--max-pages <n>', 'max pages to crawl', Number)
  .option('-c, --concurrency <n>', 'tests to run in parallel', Number)
  .option('--expect-url <fragment>', 'with --goal: final URL must contain this')
  .option(
    '--expect-text <text>',
    'with --goal: text that must be visible (repeatable)',
    collect,
    [],
  )
  .option('-s, --suite <file>', 'run a committed test suite (JSON) instead of planning')
  .option('--no-cache', 'always use the AI agent: do not replay or save recordings')
  .option('--no-heal', 'a broken replay is a plain failure; never hand it to the agent (CI)')
  .option(
    '--no-explain',
    'do not ask the judge model to explain failed tests (advisory, 1 call per failure)',
  )
  .option('--rerecord', 'ignore saved recordings and record them again with the agent')
  .option('--replan', 'ignore the saved AI test plan and plan again')
  .option(
    '--quality <gate>',
    'Web Vitals + accessibility: off | warn (default, advisory) | fail (a breach fails the test)',
  )
  .option(
    '--visual <gate>',
    'screenshots vs approved baselines: off | warn (default, for review) | fail (a difference fails the test)',
  )
  .option('--update-baselines', 'accept the screenshots of every passing test as the new baselines')
  .option(
    '--login-url <url>',
    'log in here first (username/password from AIE2E_USERNAME / AIE2E_PASSWORD)',
  )
  .option(
    '--theme-from <url>',
    'check the theme against another product (its CSS variables), e.g. your design-system site',
  )
  .option('--login-success-text <text>', 'with --login-url: text that proves the login worked')
  .option('--login-success-url <part>', 'with --login-url: URL part that proves the login worked')
  .option('--headed', 'show the browser')
  .option('--max-steps <n>', 'max agent steps per test', Number)
  .option('-m, --model <provider/model>', 'browser-agent model (overrides the preset)')
  .option('--preset <name>', 'models by role: economy | balanced | best (AIE2E_PRESET)')
  .option(
    '--agent-engine <name>',
    'who drives the browser: stagehand | loop (own loop, any model; AIE2E_AGENT_ENGINE)',
  )
  .option('-o, --out <dir>', 'output directory')
  .option('-v, --verbose', 'debug logging')
  .action(async (/** @type {string} */ url, /** @type {Record<string, any>} */ o) => {
    const { report } = await startRun({
      url,
      preset: o.preset,
      agentEngine: o.agentEngine,
      description: o.description,
      goal: o.goal,
      expectUrl: o.expectUrl,
      expectText: o.expectText,
      model: o.model,
      headed: !!o.headed,
      maxSteps: o.maxSteps,
      maxTests: o.maxTests,
      maxPages: o.maxPages,
      concurrency: o.concurrency,
      outDir: o.out,
      verbose: !!o.verbose,
      plan: o.plan,
      crawl: o.crawl,
      cache: o.cache,
      rerecord: !!o.rerecord,
      replan: !!o.replan,
      quality: o.quality,
      visual: o.visual,
      themeFrom: o.themeFrom,
      auth: o.loginUrl
        ? {
            loginUrl: o.loginUrl,
            successText: o.loginSuccessText,
            successUrl: o.loginSuccessUrl,
            usernameEnv: 'AIE2E_USERNAME',
            passwordEnv: 'AIE2E_PASSWORD',
          }
        : undefined,
      updateBaselines: !!o.updateBaselines,
      suite: o.suite,
      heal: o.heal,
      explain: o.explain,
    });
    const s = report.summary;
    process.exitCode = s.errored ? 2 : s.failed ? 1 : 0;
  });

program
  .command('ui')
  .description('open the local web UI: start runs, watch the browser live, browse results')
  .option('-p, --port <n>', 'port', Number, 4173)
  .option(
    '--host <address>',
    'address to listen on (default 127.0.0.1; 0.0.0.0 needs AIE2E_ACCESS_CODE)',
  )
  .option('-o, --out <dir>', 'output directory')
  .option('--no-open', 'do not open a browser tab')
  .action(async (/** @type {Record<string, any>} */ o) => {
    const config = loadConfig({ outDir: o.out });
    const host = o.host ?? process.env.AIE2E_HOST ?? '127.0.0.1';
    const port = o.port;
    // listening beyond this machine launches browsers with your API key for whoever connects
    if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host) && !process.env.AIE2E_ACCESS_CODE?.trim()) {
      console.error(
        `Listening on ${host} needs an access code: set AIE2E_ACCESS_CODE (see docs/DEPLOY.md).`,
      );
      process.exitCode = 2;
      return;
    }
    const uiDir = fileURLToPath(new URL('../../ui/dist', import.meta.url));
    if (!existsSync(path.join(uiDir, 'index.html'))) {
      console.error('The UI is not built yet. Run: npm run ui:build   (or use: npm run ui)');
      process.exitCode = 2;
      return;
    }
    const { createServer } = await import('../server/app.js');
    const { app } = await createServer({ outDir: config.outDir, uiDir });
    await app.listen({ host, port });
    const url = `http://localhost:${port}`;
    console.log(`AI E2E Agent UI: ${url}   (Ctrl+C to stop)`);
    if (o.open && host === '127.0.0.1') openInBrowser(url);
  });

program
  .command('export')
  .argument('<runId>', 'a finished run (its folder name under <out>/runs)')
  .description('turn a run into a committed test suite: its tests plus their recorded steps')
  .option('-o, --output <file>', 'where to write the suite', 'aie2e.suite.json')
  .option('--out <dir>', 'output directory of the runs')
  .action(async (/** @type {string} */ runId, /** @type {Record<string, any>} */ o) => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const { FileRecordStore } = await import('../storage/recordStore.js');
    const { suiteFromRun } = await import('../planner/suitePlanner.js');
    const config = loadConfig({ outDir: o.out });
    const report = JSON.parse(
      await readFile(path.join(config.outDir, 'runs', runId, 'report.json'), 'utf8'),
    );
    const store = new FileRecordStore(path.join(config.outDir, 'recordings'));
    const suite = await suiteFromRun(report, (id) => store.load(id));
    await writeFile(o.output, JSON.stringify(suite, null, 2));
    const withSteps = suite.tests.filter((t) => t.steps).length;
    console.log(
      `Wrote ${suite.tests.length} tests (${withSteps} with recorded steps) to ${o.output}. Run it with: aie2e run <url> --suite ${o.output}`,
    );
  });

program
  .command('doctor')
  .description('check the environment')
  .action(() => {
    const config = loadConfig();
    /** @type {[string, boolean, string][]} */
    const rows = [];
    const major = Number(process.versions.node.split('.')[0]);
    rows.push(['Node >= 20', major >= 20, process.versions.node]);
    const chrome = resolveChromePath(config) ?? '';
    rows.push([
      'Chromium available',
      !!chrome && existsSync(chrome),
      chrome || `run: npm run browsers (expected ${safeExecutablePath()})`,
    ]);
    const keyVar = apiKeyEnvFor(config.model);
    rows.push([
      `API key for ${config.model}`,
      keyVar ? !!process.env[keyVar] : true,
      keyVar ?? 'unknown provider: only anthropic/, openai/, google/ are supported',
    ]);
    const warning = agentModelWarning(config.model, config.agentEngine);
    rows.push([
      'Browser-agent model works with Stagehand 3.7.3',
      !warning,
      warning ?? config.model,
    ]);
    rows.push([
      'Planner / judge models',
      true,
      `${config.plannerModel ?? config.model} / ${config.judgeModel ?? config.model}${config.preset ? ` (preset ${config.preset})` : ''}`,
    ]);
    for (const [name, ok, detail] of rows)
      console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  (${detail})`);
    process.exitCode = rows.every(([, ok]) => ok) ? 0 : 1;
  });

/** @param {string} value @param {string[]} previous */
function collect(value, previous) {
  return [...previous, value];
}

function safeExecutablePath() {
  try {
    return chromium.executablePath();
  } catch {
    return 'unknown';
  }
}

/** @param {string} url */
function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  execFile(cmd, args, () => undefined); // best effort; the URL is printed anyway
}

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
});
