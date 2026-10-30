#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * saucedemo: Sauce Labs' demo shop (saucelabs/sample-app-web, MIT, see app/LICENSE), served from a
 * production build of the unmodified source. Its bugs are built in and chosen by WHO logs in:
 *
 *   standard_user            the working app (record and approve baselines with this one)
 *   problem_user             wrong images, sorting ignored, some add-to-cart buttons dead, last name broken
 *   error_user               errors on sort, add/remove, last name and finish (reported to Backtrace)
 *   visual_user              misaligned and altered UI (header, cart, first product)
 *   performance_glitch_user  the product list blocks for 5 seconds
 *   locked_out_user          cannot log in
 *
 * Every user's password is `secret_sauce` (printed on the login page; it is a public demo credential).
 * The tester reads them from AIE2E_USERNAME / AIE2E_PASSWORD like any other login.
 *
 *   node examples/saucedemo/server.js            http://localhost:4500
 *   PORT=5000 node examples/saucedemo/server.js
 */

const ROOT = fileURLToPath(new URL('./app/', import.meta.url));
/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** A single-page app: every route without a file of its own (/inventory.html, /cart.html …) is index.html. */
export function createSauceDemo() {
  return http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = path.join(ROOT, pathname);
    if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
    const send = (/** @type {string} */ f, /** @type {Buffer} */ body) => {
      res.writeHead(200, {
        'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream',
      });
      res.end(body);
    };
    try {
      if (pathname === '/' || pathname.endsWith('/')) throw new Error('directory');
      send(file, await readFile(file));
    } catch {
      if (pathname.startsWith('/assets/'))
        return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      send('index.html', await readFile(path.join(ROOT, 'index.html')));
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4500);
  createSauceDemo().listen(port, '127.0.0.1', () =>
    console.log(`Sauce Demo on http://localhost:${port} (users: see examples/saucedemo/README.md)`),
  );
}
