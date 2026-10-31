#!/usr/bin/env node
import 'dotenv/config';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from '../src/server/app.js';

/**
 * Export finished runs for the read-only showcase (`npm run demo:build`, deployed as static files).
 *
 * Every API answer the UI reads is captured from the real server (`app.inject`), so the showcase shows
 * exactly what `npm run ui` shows: the run list, each run, suites, recordings, and every file of each
 * run folder (screenshots, visual diffs, report.html). Nothing that can start a browser is exported.
 *
 *   npm run demo:export -- --runs 20261030110646-7137,20261030092346-fb5e
 *   npm run demo:export -- --all
 *
 * Output: .aie2e/showcase (the demo build's public folder). Reports never contain passwords (D18), but
 * look at what you export: URLs, usernames and screenshots of the apps are in it.
 */
const { values: args } = parseArgs({
  options: {
    runs: { type: 'string' },
    all: { type: 'boolean', default: false },
    out: { type: 'string', default: '.aie2e/showcase' },
    from: { type: 'string', default: process.env.AIE2E_OUT_DIR || '.aie2e' },
  },
});
if (!args.runs && !args.all) {
  console.error('Pick the runs to publish: --runs <id,id,...> (see `npm run ui` → Runs) or --all');
  process.exit(2);
}

const out = path.resolve(args.out);
const from = path.resolve(args.from);
const { app } = await createServer({ outDir: from });
/** GET through the real routes, as the UI would. @param {string} url */
const get = async (url) => {
  const res = await app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
  if (res.statusCode !== 200)
    throw new Error(`${url}: HTTP ${res.statusCode} ${res.body.slice(0, 200)}`);
  return res.json();
};
/** @param {string} rel @param {unknown} data */
const save = async (rel, data) => {
  const file = path.join(out, 'demo', 'api', `${rel}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
};

await rm(path.join(out, 'demo'), { recursive: true, force: true });

const all = /** @type {{ runId: string, status: string }[]} */ (await get('/api/runs'));
const wanted = args.all
  ? all.filter((r) => r.status === 'done').map((r) => r.runId)
  : String(args.runs)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
const missing = wanted.filter((id) => !all.some((r) => r.runId === id));
if (missing.length) {
  console.error(`Not found in ${from}/runs: ${missing.join(', ')}`);
  process.exit(2);
}

await save(
  'runs',
  all.filter((r) => wanted.includes(r.runId)),
);
for (const id of wanted) {
  await save(`runs/${id}`, await get(`/api/runs/${id}`));
  await cp(path.join(from, 'runs', id), path.join(out, 'demo', 'files', 'runs', id), {
    recursive: true,
  });
  console.log(`run ${id}`);
}

const health = await get('/api/health');
await save('health', {
  ...health,
  demo: true,
  keyPresent: true, // no warnings in a read-only showcase; nothing runs there
  outDir: undefined,
  chrome: undefined,
  active: null,
  loginCreds: false,
});

const suites = /** @type {{ name: string }[]} */ (await get('/api/suites'));
await save('suites', suites);
for (const s of suites) await save(`suites/${s.name}`, await get(`/api/suites/${s.name}`));

const recs = /** @type {{ testId: string }[]} */ (await get('/api/recordings'));
await save('recordings', recs);
for (const r of recs)
  await save(`recordings/${r.testId}`, await get(`/api/recordings/${r.testId}`));

await app.close();
console.log(
  `\nExported ${wanted.length} run(s), ${suites.length} suite(s), ${recs.length} recording(s) to ${path.relative(process.cwd(), out)}.` +
    `\nNext: npm run demo:build, then deploy ui/dist-demo (e.g. npx vercel deploy ui/dist-demo --prod).`,
);
