#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Container entry point (Dockerfile, docs/DEPLOY.md). Starts the three demo apps next to the UI so a
 * visitor has something to test, copies the baked-in runs into an empty output folder, then starts the
 * UI on $PORT for everyone, behind the access code.
 *
 * Defaults it fills in (any of them can be set on the platform instead):
 *   AIE2E_ALLOWED_TARGETS  the demo apps, by name
 *   AIE2E_ALLOWED_HOSTS    the public host name the platform gives the service (RENDER_EXTERNAL_HOSTNAME)
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env };

if (!env.AIE2E_ACCESS_CODE?.trim()) {
  console.error(
    'AIE2E_ACCESS_CODE is not set. A deployed instance needs one (see docs/DEPLOY.md).',
  );
  process.exit(2);
}
/** @type {[string, string, number][]} */
const APPS = [
  ['Sauce Demo', 'examples/saucedemo/server.js', 4500],
  ['Buggy shop', 'examples/buggy-shop/server.js', 4300],
  ['TodoMVC', 'examples/todomvc/server.js', 4400],
];
env.AIE2E_ALLOWED_TARGETS ||= APPS.map(([name, , port]) => `${name}=http://localhost:${port}`).join(
  ',',
);
env.AIE2E_ALLOWED_HOSTS ||= env.RENDER_EXTERNAL_HOSTNAME ?? '';
if (!env.AIE2E_ALLOWED_HOSTS)
  console.warn(
    'AIE2E_ALLOWED_HOSTS is empty: set it to the public host name, or only localhost works.',
  );

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
/** @param {string[]} args @param {NodeJS.ProcessEnv} childEnv */
const start = (args, childEnv) => {
  const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: 'inherit' });
  children.push(child);
  return child;
};

for (const [, script, port] of APPS) start([script], { ...env, PORT: String(port) });

// Runs, recordings, suites, plans and baselines baked into the image appear on first start.
const outDir = path.resolve(root, env.AIE2E_OUT_DIR || '.aie2e');
const seed = path.join(root, 'deploy', 'seed');
await mkdir(outDir, { recursive: true });
if (existsSync(seed) && (await readdir(outDir)).length === 0) {
  await cp(seed, outDir, { recursive: true });
  console.log(`Copied the baked-in runs into ${outDir}`);
}

// the platform's port (Render sets PORT, default 10000)
const port = String(Number(env.PORT) || 10000);
const ui = start(['src/cli/main.js', 'ui', '--host', '0.0.0.0', '--port', port, '--no-open'], env);
ui.on('exit', (code) => {
  for (const c of children) c.kill();
  process.exit(code ?? 1);
});
for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT']))
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
  });
