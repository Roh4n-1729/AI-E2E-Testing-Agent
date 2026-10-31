#!/usr/bin/env node
import 'dotenv/config';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/**
 * Bake finished runs into the deployed image (deploy/seed, copied into the output folder on first
 * start by deploy/serve.js). With them: every recording, saved plan, suite and approved screenshot,
 * so replays and "Run again" work on the deployed instance.
 *
 *   npm run deploy:seed -- --runs 20261031031448-f7d8,20261031042745-a821
 *
 * Look at what you bake in: it is committed and served to anyone with the access code. Reports
 * never hold passwords (D18), but they hold URLs, usernames and screenshots of the apps.
 */
const { values: args } = parseArgs({
  options: {
    runs: { type: 'string' },
    from: { type: 'string', default: process.env.AIE2E_OUT_DIR || '.aie2e' },
  },
});
if (!args.runs) {
  console.error('Pick the runs to bake in: --runs <id,id,...> (ids from the UI: #/runs/<id>)');
  process.exit(2);
}
const from = path.resolve(args.from);
const out = path.resolve('deploy', 'seed');
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'runs'), { recursive: true });

const ids = args.runs
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const id of ids) {
  const src = path.join(from, 'runs', id);
  if (!/^[\w-]+$/.test(id) || !existsSync(src)) {
    console.error(`Run not found: ${src}`);
    process.exit(2);
  }
  await cp(src, path.join(out, 'runs', id), { recursive: true });
}
for (const dir of ['recordings', 'plans', 'suites', 'baselines'])
  if (existsSync(path.join(from, dir)))
    await cp(path.join(from, dir), path.join(out, dir), { recursive: true });

/** @param {string} dir @returns {Promise<number>} */
const size = async (dir) => {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }))
    n += e.isDirectory()
      ? await size(path.join(dir, e.name))
      : (await stat(path.join(dir, e.name))).size;
  return n;
};
console.log(
  `Baked ${ids.length} run(s) into deploy/seed (${((await size(out)) / 1e6).toFixed(1)} MB). Commit it, then deploy.`,
);
