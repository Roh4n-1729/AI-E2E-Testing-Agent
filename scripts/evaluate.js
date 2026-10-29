#!/usr/bin/env node
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startRun } from '../src/app/startRun.js';
import { createShop } from '../examples/buggy-shop/server.js';

/**
 * Evaluation: how good is the tester at finding real bugs, and how often does it cry wolf?
 *
 *   npm run eval                          seeded-bug shop, committed suite, no LLM needed
 *   npm run eval -- --mode explore        same, but the AI explores and plans its own tests
 *   npm run eval -- --url https://app --runs 3   any app: repeatability, time and cost only
 *
 * Method (seeded-bug shop): run the CLEAN app N times (false positives, flakiness), then switch on
 * ONE known bug at a time and run again. A bug counts as detected when a test that passes on the
 * clean app fails, or a new quality warning appears. Attribution is exact because only one bug
 * differs between the runs. Results go to docs/EVALUATION.md and a JSON file next to the runs.
 */

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'suite' },
    runs: { type: 'string', default: '2' },
    bugs: { type: 'string' },
    url: { type: 'string' },
    port: { type: 'string', default: '4310' },
    concurrency: { type: 'string', default: '3' },
    heal: { type: 'boolean', default: false },
    hints: { type: 'boolean', default: false },
    report: { type: 'string', default: 'docs/EVALUATION.md' },
    model: { type: 'string' },
  },
});

const shopDir = path.resolve('examples/buggy-shop');
const truth = JSON.parse(await readFile(path.join(shopDir, 'bugs.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outDir = path.resolve('.aie2e', 'eval', stamp);
process.env.AIE2E_LOG_LEVEL ??= 'warn';

/** @typedef {import('../src/core/types.js').RunReport} RunReport */
/** @typedef {{ label: string, bug?: string, report: RunReport, ms: number }} EvalRun */

/** @param {string} label @param {string} url @param {string} [bug] @returns {Promise<EvalRun>} */
async function run(label, url, bug) {
  process.stdout.write(`  ${label.padEnd(28)} `);
  const t0 = Date.now();
  const { report } = await startRun({
    url,
    outDir,
    concurrency: Number(args.concurrency),
    quality: 'warn',
    heal: args.heal,
    model: args.model,
    ...(args.url
      ? {}
      : args.mode === 'suite'
        ? { suite: path.join(shopDir, 'suite.json') }
        : { description: truth.description, maxTests: 6 }),
  });
  const ms = Date.now() - t0;
  const s = report.summary;
  console.log(`${s.passed}/${s.total} passed  ${(ms / 1000).toFixed(1)}s`);
  return { label, bug, report, ms };
}

/** @param {string} bugs @param {number} port */
function serveShop(bugs, port) {
  const server = createShop({ bugs, hints: args.hints });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
/** @param {import('node:http').Server} s */
const close = (s) => new Promise((r) => s.close(() => r(undefined)));

/** @param {RunReport} report */
const statusById = (report) => new Map(report.results.map((r) => [r.test.id, r.verdict.status]));
/** @param {RunReport} report */
const warningsOf = (report) =>
  new Set(
    report.results.flatMap((r) =>
      r.verdict.warnings.map((w) => `${r.test.title}: ${w.replace(/[\d.]+s\b/g, 'Ns')}`),
    ),
  );
/** @param {RunReport} r */
const tokens = (r) =>
  r.summary.inputTokens +
  r.summary.outputTokens +
  (r.summary.overhead?.inputTokens ?? 0) +
  (r.summary.overhead?.outputTokens ?? 0);
/** @param {RunReport} r */
const modes = (r) => {
  /** @type {Record<string, number>} */
  const m = {};
  for (const x of r.results) m[x.mode] = (m[x.mode] ?? 0) + 1;
  return Object.entries(m)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
};

await mkdir(outDir, { recursive: true });
const port = Number(args.port);
/** @type {EvalRun[]} */
const clean = [];
/** @type {EvalRun[]} */
const bugRuns = [];
const nRuns = Math.max(1, Number(args.runs));

if (args.url) {
  console.log(`Evaluating ${args.url}: ${nRuns} runs`);
  for (let i = 1; i <= nRuns; i++) clean.push(await run(`run ${i}`, args.url));
} else {
  const url = `http://localhost:${port}/`;
  const bugs = args.bugs ? args.bugs.split(',') : truth.bugs.map((/** @type {any} */ b) => b.id);
  console.log(
    `Evaluating buggy-shop (${args.mode} mode, healing ${args.heal ? 'on' : 'off'}) -> ${outDir}`,
  );
  let server = await serveShop('none', port);
  for (let i = 1; i <= nRuns; i++) clean.push(await run(`clean app, run ${i}`, url));
  await close(server);
  for (const bug of bugs) {
    server = await serveShop(bug, port);
    bugRuns.push(await run(`bug: ${bug}`, url, bug));
    await close(server);
  }
}

// ---- analysis ------------------------------------------------------------------------------------
const testIds = [...new Set(clean.flatMap((r) => r.report.results.map((x) => x.test.id)))];
const titles = new Map(
  clean.flatMap((r) => r.report.results.map((x) => [x.test.id, x.test.title])),
);
const flaky = testIds.filter(
  (id) => new Set(clean.map((r) => statusById(r.report).get(id))).size > 1,
);
const falsePositives = testIds.filter((id) =>
  clean.some((r) => statusById(r.report).get(id) !== 'pass'),
);
const stablePass = testIds.filter((id) =>
  clean.every((r) => statusById(r.report).get(id) === 'pass'),
);
const cleanWarnings = new Set(clean.flatMap((r) => [...warningsOf(r.report)]));

const detections = bugRuns.map((b) => {
  const st = statusById(b.report);
  const newlyFailing = stablePass.filter((id) => st.get(id) && st.get(id) !== 'pass');
  const newWarnings = [...warningsOf(b.report)].filter((w) => !cleanWarnings.has(w));
  const meta = truth.bugs.find((/** @type {any} */ x) => x.id === b.bug);
  return {
    bug: b.bug,
    title: meta?.title ?? b.bug,
    kind: meta?.kind ?? '',
    detected: newlyFailing.length > 0 || newWarnings.length > 0,
    failedTests: newlyFailing.map((id) => titles.get(id) ?? id),
    newWarnings,
  };
});

const result = {
  date: new Date().toISOString(),
  app: args.url ?? 'examples/buggy-shop',
  mode: args.url ? 'repeatability' : args.mode,
  heal: args.heal,
  hints: args.hints,
  model: args.model ?? process.env.AIE2E_MODEL ?? 'default',
  cleanRuns: clean.map((r) => ({
    label: r.label,
    runId: r.report.runId,
    summary: r.report.summary,
    ms: r.ms,
    modes: modes(r.report),
  })),
  bugRuns: bugRuns.map((r) => ({
    label: r.label,
    runId: r.report.runId,
    summary: r.report.summary,
    ms: r.ms,
    modes: modes(r.report),
  })),
  tests: testIds.length,
  flaky: flaky.map((id) => titles.get(id)),
  falsePositives: falsePositives.map((id) => titles.get(id)),
  detections,
};
await writeFile(path.join(outDir, 'evaluation.json'), JSON.stringify(result, null, 2));

// ---- markdown ------------------------------------------------------------------------------------
const row = (/** @type {EvalRun} */ r) =>
  `| ${r.label} | ${r.report.summary.passed}/${r.report.summary.total} | ${modes(r.report)} | ${(tokens(r.report) / 1000).toFixed(1)}k | ${(r.ms / 1000).toFixed(1)}s |`;
const detected = detections.filter((d) => d.detected).length;
const md = [
  `# Evaluation`,
  '',
  `Generated by \`npm run eval\` on ${result.date.slice(0, 10)}. App: \`${result.app}\`, mode: **${result.mode}**, healing ${args.heal ? 'on' : 'off'}${args.hints ? ', app hints on' : ''}, model \`${result.model}\`. Raw data: \`${path.relative(process.cwd(), path.join(outDir, 'evaluation.json'))}\`.`,
  '',
  ...(bugRuns.length
    ? [
        `**${detected}/${detections.length} seeded bugs detected · ${falsePositives.length} false positive${falsePositives.length === 1 ? '' : 's'} on the clean app (${clean.length} run${clean.length === 1 ? '' : 's'} × ${testIds.length} tests) · ${flaky.length} flaky test${flaky.length === 1 ? '' : 's'}.**`,
        '',
        'Method: the clean app runs first; then each bug is switched on alone. A bug counts as detected when a test that passes on the clean app fails, or a new quality warning appears.',
        '',
        '| Seeded bug | Kind | Detected | Evidence |',
        '| --- | --- | --- | --- |',
        ...detections.map(
          (d) =>
            `| ${d.title} | ${d.kind} | ${d.detected ? 'yes' : '**no**'} | ${
              [
                ...d.failedTests.map((t) => `failed: ${t}`),
                ...new Set(
                  d.newWarnings.map((w) => `warning: ${w.split(': ').slice(1).join(': ')}`),
                ),
              ]
                .slice(0, 3)
                .join('<br>')
                .replace(/\|/g, '\\|') || '–'
            } |`,
        ),
        '',
      ]
    : [
        `**${clean.length} runs × ${testIds.length} tests · ${flaky.length} flaky · ${falsePositives.length} test${falsePositives.length === 1 ? '' : 's'} not passing in every run.**`,
        '',
      ]),
  '| Run | Passed | How tests ran | Tokens | Time |',
  '| --- | --- | --- | --- | --- |',
  ...clean.map(row),
  ...bugRuns.map(row),
  '',
  flaky.length
    ? `Flaky (different results across clean runs): ${flaky.map((id) => titles.get(id)).join(', ')}.`
    : 'No flaky tests across the clean runs.',
  falsePositives.length
    ? `Not passing on the clean app: ${falsePositives.map((id) => titles.get(id)).join(', ')}.`
    : '',
  '',
].join('\n');
await mkdir(path.dirname(path.resolve(args.report)), { recursive: true });
await writeFile(args.report, md);
console.log(`\n${md}\nWrote ${args.report}`);
