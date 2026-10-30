#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * todomvc: the React TodoMVC (tastejs/todomvc, MIT, see app/LICENSE.md), served from its committed
 * production build. A real third-party app the tester did not write, used to show that nothing is
 * tied to the demo shop.
 *
 *   node examples/todomvc/server.js                     the real app, http://localhost:4400
 *   BUGS=clear-broken node examples/todomvc/server.js   with a regression switched on
 *   PORT=5000 node examples/todomvc/server.js
 *
 * The build is never edited: a regression is a small script added to index.html when it is served.
 */

const ROOT = fileURLToPath(new URL('./app/', import.meta.url));
/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Regressions that can be switched on, as the script that causes each one. */
export const TODOMVC_BUGS = {
  /** "Clear completed" does nothing: its click never reaches React. */
  'clear-broken': `window.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('.clear-completed')) e.stopPropagation();
  }, true);`,
  /** Enter in the edit box is ignored, so an edit is never saved. */
  'edit-lost': `window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof Element && e.target.matches('li.editing input.edit')) e.stopPropagation();
  }, true);`,
};

/** @param {string} [spec] comma-separated bug ids, or "none" */
const parseBugs = (spec = 'none') =>
  spec === 'all'
    ? Object.keys(TODOMVC_BUGS)
    : spec
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s in TODOMVC_BUGS);

/** @param {{ bugs?: string }} [o] */
export function createTodoMvc({ bugs = 'none' } = {}) {
  const on = /** @type {(keyof typeof TODOMVC_BUGS)[]} */ (parseBugs(bugs));
  const inject = on.length ? `<script>${on.map((b) => TODOMVC_BUGS[b]).join('\n')}</script>` : '';
  return http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
    try {
      let body = await readFile(file);
      if (inject && file.endsWith('index.html'))
        body = Buffer.from(body.toString('utf8').replace('</head>', `${inject}</head>`));
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4400);
  const bugs = process.env.BUGS ?? 'none';
  createTodoMvc({ bugs }).listen(port, '127.0.0.1', () =>
    console.log(
      `TodoMVC (React) on http://localhost:${port}${bugs === 'none' ? '' : ` with bugs: ${bugs}`}`,
    ),
  );
}
