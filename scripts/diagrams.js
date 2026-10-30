#!/usr/bin/env node
/**
 * Render every docs/diagrams/*.mmd to a PNG next to it. Works the same on Windows, macOS and Linux.
 * Uses the Mermaid CLI: a global `mmdc` if there is one, otherwise `npx @mermaid-js/mermaid-cli`.
 *
 *   npm run diagrams
 *   npm run diagrams -- 01-components      only the diagrams whose name contains this
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../docs/diagrams/', import.meta.url));
const only = process.argv[2];
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.mmd') && (!only || f.includes(only)))
  .sort();
if (!files.length) {
  console.error(`No diagrams${only ? ` matching "${only}"` : ''} in ${dir}`);
  process.exit(1);
}

const win = process.platform === 'win32';
const hasMmdc = spawnSync(win ? 'where' : 'which', ['mmdc'], { stdio: 'ignore' }).status === 0;
const [cmd, base] = hasMmdc ? ['mmdc', []] : ['npx', ['-y', '@mermaid-js/mermaid-cli@11']];

let failed = 0;
for (const f of files) {
  const input = path.join(dir, f);
  const output = input.replace(/\.mmd$/, '.png');
  const args = [...base, '-i', input, '-o', output, '-b', 'white', '-w', '1600', '-s', '2'];
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: win });
  if (r.status === 0) console.log(`✓ ${path.basename(output)}`);
  else {
    failed++;
    console.error(`✗ ${f}\n${r.stderr?.toString().trim()}`);
  }
}
process.exit(failed ? 1 : 0);
