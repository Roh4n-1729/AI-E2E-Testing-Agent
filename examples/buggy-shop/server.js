#!/usr/bin/env node
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * buggy-shop: a tiny shop with KNOWN, switchable bugs, used to measure what the tester catches.
 *
 *   node examples/buggy-shop/server.js                 all bugs on, port 4300
 *   BUGS=none node examples/buggy-shop/server.js       the clean app (false-positive baseline)
 *   BUGS=wrong-total,dead-button ...                   only these
 *   HINTS=1 ...                                        add data-testid / aria-busy hints
 *
 * Ground truth lives in bugs.json. GET /__bugs returns the bugs that are switched on.
 * No dependencies on purpose: anyone can run it.
 */

const KNOWN = JSON.parse(readFileSync(new URL('./bugs.json', import.meta.url), 'utf8')).bugs.map(
  (/** @type {{ id: string }} */ b) => b.id,
);

/** @param {string | undefined} spec @returns {Set<string>} */
export function parseBugs(spec = 'all') {
  if (spec === 'all') return new Set(KNOWN);
  if (spec === 'none' || spec === '') return new Set();
  return new Set(
    spec
      .split(',')
      .map((s) => s.trim())
      .filter((s) => KNOWN.includes(s)),
  );
}

const PRODUCTS = [
  { id: 'mug', name: 'Coffee Mug', price: 299, color: '#d97706' },
  { id: 'tee', name: 'Cotton T-shirt', price: 599, color: '#2563eb' },
  { id: 'notebook', name: 'Notebook', price: 149, color: '#059669' },
];

/**
 * The shop's theme: every colour, radius, font and type size comes from these tokens, in light and
 * dark, exactly like a production design system. Three theme bugs can be switched on.
 * @param {Set<string>} bugs
 */
const css = (
  bugs,
) => `:root{--color-bg:#f7f7f8;--color-surface:#ffffff;--color-text:#1d1d1f;--color-muted:#5f6368;--color-border:#e4e4e7;
--color-primary:#2563eb;--color-on-primary:#ffffff;--color-danger:#b91c1c;--color-toast:#1d1d1f;--color-on-toast:#fafafa;
--radius-sm:8px;--radius-md:12px;--text-base:15px;--text-lg:18px;--text-xl:22px;--text-2xl:32px;
--font-sans:system-ui, sans-serif}
.dark{--color-bg:#0f1115;--color-surface:#181b21;--color-text:#e8e8ea;--color-muted:#a1a1aa;--color-border:#2c313a;
--color-primary:#60a5fa;--color-on-primary:#0f1115;--color-danger:#f87171;--color-toast:#e8e8ea;--color-on-toast:#0f1115}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font-sans);font-size:var(--text-base);line-height:1.5;color:var(--color-text);background:var(--color-bg)}
h1{font-size:var(--text-2xl);margin:0 0 16px}h2{font-size:var(--text-xl)}h3{font-size:var(--text-lg)}
a{color:var(--color-primary)}
header{display:flex;gap:20px;align-items:center;padding:14px 28px;background:var(--color-surface);border-bottom:1px solid var(--color-border)}
header a{color:var(--color-text);text-decoration:none}header .brand{font-weight:700;margin-right:auto}
main{max-width:920px;margin:0 auto;padding:28px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:16px}
.card img{width:100%;height:120px;border-radius:var(--radius-sm);display:block}
button,.btn{background:var(--color-primary);color:var(--color-on-primary);border:0;border-radius:var(--radius-sm);padding:9px 14px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border)}
input{font:inherit;color:var(--color-text);background:var(--color-surface);padding:8px 10px;border:1px solid var(--color-border);border-radius:var(--radius-sm);width:100%}
.row{display:flex;gap:10px;align-items:center}.muted{color:var(--color-muted)}.err{color:var(--color-danger)}.total{font-size:var(--text-lg)}
.toast{position:fixed;bottom:20px;right:20px;background:var(--color-toast);color:var(--color-on-toast);padding:10px 14px;border-radius:var(--radius-md)}
table{width:100%;border-collapse:collapse;background:var(--color-surface)}td,th{padding:10px;border-bottom:1px solid var(--color-border);text-align:left}
${bugs.has('hardcoded-color') ? '.newsletter button{background:#2f6fe4}' : ''}
${bugs.has('dark-leak') ? '.newsletter{background:#ffffff}' : ''}
${bugs.has('off-scale-radius') ? '.product{border-radius:7px}' : ''}
${bugs.has('button-drift') ? '#f button{background:color-mix(in srgb, var(--color-primary) 88%, black)}' : ''}`;

/** @param {string} color */
const swatch = (color) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect width="300" height="120" fill="${color}"/></svg>`)}`;

/**
 * @param {Set<string>} bugs @param {boolean} hints
 * @param {string} title @param {string} body
 */
function page(bugs, hints, title, body) {
  const tid = (/** @type {string} */ id) => (hints ? ` data-testid="${id}"` : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Buggy Shop</title><style>${css(bugs)}</style>
<script>
try { if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark'); } catch {}
const toggleTheme = () => { const d = document.documentElement.classList.toggle('dark'); try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch {} };
const BUGS = ${JSON.stringify([...bugs])};
const PRODUCTS = ${JSON.stringify(PRODUCTS)};
const cart = () => { try { return JSON.parse(localStorage.getItem('cart') || '{}'); } catch { return {}; } };
const save = (c) => { localStorage.setItem('cart', JSON.stringify(c)); renderCount(); };
const renderCount = () => { const c = cart(); document.getElementById('count').textContent = Object.values(c).reduce((a, b) => a + b, 0); };
const toast = (msg) => { const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2500); };
addEventListener('DOMContentLoaded', renderCount);
</script>
</head><body>
<header><a class="brand" href="/">Buggy Shop</a><a href="/"${tid('nav-shop')}>Shop</a><a href="/about">About</a><a href="/cart"${tid('nav-cart')}>Cart (<span id="count">0</span>)</a><button class="ghost" type="button" onclick="toggleTheme()" title="Switch between light and dark"${tid('theme-toggle')}>Theme</button></header>
<main>${body}</main>
</body></html>`;
}

/** @param {Set<string>} bugs @param {boolean} hints */
function home(bugs, hints) {
  const tid = (/** @type {string} */ id) => (hints ? ` data-testid="${id}"` : '');
  const cards = PRODUCTS.map(
    (
      p,
    ) => `<div class="card product"><img src="${swatch(p.color)}"${bugs.has('missing-alt') ? '' : ` alt="${p.name}"`}>
<h3>${p.name}</h3><p class="muted">₹${p.price}</p>
<button${tid(`add-${p.id}`)} onclick="${bugs.has('dead-button') && p.id === 'notebook' ? '' : `const c = cart(); c['${p.id}'] = (c['${p.id}'] || 0) + 1; save(c); toast('Added ${p.name} to cart')`}">Add to cart</button></div>`,
  ).join('');
  return page(
    bugs,
    hints,
    'Shop',
    `<h1>Shop</h1>
<div class="row" style="margin-bottom:18px"><input id="q" placeholder="Search products" aria-label="Search products"${tid('search-input')}><button${tid('search-button')} onclick="search()">Search</button></div>
<p id="results" class="muted" aria-live="polite"></p>
<div class="grid">${cards}</div>
<section style="margin-top:32px" class="card newsletter"><h2>Newsletter</h2>
<form class="row" onsubmit="event.preventDefault(); subscribe()"><input id="email" type="email" placeholder="you@example.com" aria-label="Email for the newsletter"${tid('newsletter-email')}><button${tid('newsletter-subscribe')}>Subscribe</button></form>
<p id="sub" aria-live="polite"></p></section>
<script>
async function search() {
  const box = document.getElementById('results');
  ${hints ? "document.querySelector('main').setAttribute('aria-busy', 'true');" : ''}
  box.textContent = 'Searching…';
  const r = await fetch('/api/search?q=' + encodeURIComponent(document.getElementById('q').value));
  const { results } = await r.json();
  box.textContent = results.length ? 'Found: ' + results.join(', ') : 'No products found';
  ${hints ? "document.querySelector('main').removeAttribute('aria-busy');" : ''}
}
async function subscribe() {
  const r = await fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('email').value }) });
  ${bugs.has('fake-subscribe') ? "document.getElementById('sub').textContent = 'Subscribed! Check your inbox.';" : "document.getElementById('sub').textContent = r.ok ? 'Subscribed! Check your inbox.' : 'Could not subscribe, please try again.';"}
}
</script>`,
  );
}

/** @param {Set<string>} bugs @param {boolean} hints */
function cartPage(bugs, hints) {
  const tid = (/** @type {string} */ id) => (hints ? ` data-testid="${id}"` : '');
  return page(
    bugs,
    hints,
    'Cart',
    `<h1>Your cart</h1><table><thead><tr><th>Product</th><th>Price</th><th>Quantity</th></tr></thead><tbody id="rows"></tbody></table>
<p class="total">Total: <strong id="total"${tid('cart-total')}>₹0</strong></p>
<a class="btn" href="/checkout"${tid('checkout-link')}>Checkout</a>
<script>
function render() {
  const c = cart();
  const rows = PRODUCTS.filter((p) => c[p.id]).map((p) => '<tr><td>' + p.name + '</td><td>₹' + p.price + '</td><td><button aria-label="Fewer ' + p.name + '" onclick="change(\\'' + p.id + '\\', -1)">−</button> <span>' + c[p.id] + '</span> <button aria-label="More ' + p.name + '" onclick="change(\\'' + p.id + '\\', 1)">+</button></td></tr>');
  document.getElementById('rows').innerHTML = rows.join('') || '<tr><td colspan="3" class="muted">Your cart is empty</td></tr>';
  const total = PRODUCTS.reduce((sum, p) => sum + (c[p.id] ? p.price * (BUGS.includes('wrong-total') ? 1 : c[p.id]) : 0), 0);
  document.getElementById('total').textContent = '₹' + total;
}
function change(id, d) { const c = cart(); c[id] = Math.max(0, (c[id] || 0) + d); if (!c[id]) delete c[id]; save(c); render(); }
render();
if (BUGS.includes('console-error')) { setTimeout(() => { throw new TypeError('cart-render: cannot read the quantity of an undefined line item'); }, 50); }
</script>`,
  );
}

/** @param {Set<string>} bugs @param {boolean} hints */
function checkout(bugs, hints) {
  const tid = (/** @type {string} */ id) => (hints ? ` data-testid="${id}"` : '');
  return page(
    bugs,
    hints,
    'Checkout',
    `<h1>Checkout</h1>
<form id="f" class="card" style="display:grid;gap:12px;max-width:420px" novalidate onsubmit="event.preventDefault(); place()">
<label>Name <input id="name"${tid('checkout-name')}></label>
<label>Email <input id="email" type="email"${tid('checkout-email')}></label>
<label>Address <input id="addr"${tid('checkout-address')}></label>
<button${tid('place-order')}>Place order</button><p id="msg" role="alert"></p></form>
<script>
function place() {
  const email = document.getElementById('email').value.trim();
  const msg = document.getElementById('msg');
  if (!BUGS.includes('no-validation') && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) { msg.className = 'err'; msg.textContent = 'Please enter a valid email address'; return; }
  localStorage.removeItem('cart');
  document.querySelector('main').innerHTML = '<h1>Order placed!</h1><p>Your order number is <strong>#' + (1000 + Math.floor(Math.random() * 9000)) + '</strong>.</p><a href="/">Continue shopping</a>';
  renderCount();
}
</script>`,
  );
}

/**
 * @param {{ bugs?: string, hints?: boolean }} [opts]
 * @returns {http.Server}
 */
export function createShop({ bugs: spec = 'all', hints = false } = {}) {
  const bugs = parseBugs(spec);
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const html = (/** @type {string} */ s) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(s);
    };
    const json = (/** @type {number} */ code, /** @type {unknown} */ body) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/__bugs') return json(200, { bugs: [...bugs] });
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const results = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q)).map((p) => p.name);
      return void setTimeout(() => json(200, { results }), bugs.has('slow-search') ? 3500 : 150);
    }
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      return bugs.has('fake-subscribe')
        ? json(500, { error: 'mail provider down' })
        : json(200, { ok: true });
    }
    if (url.pathname === '/favicon.ico') {
      res.statusCode = 204;
      return void res.end();
    }
    if (url.pathname === '/') return html(home(bugs, hints));
    if (url.pathname === '/cart') return html(cartPage(bugs, hints));
    if (url.pathname === '/checkout') return html(checkout(bugs, hints));
    if (url.pathname === '/about')
      return html(
        page(
          bugs,
          hints,
          'About',
          '<h1>About us</h1><p>We sell three things and test them with AI.</p>',
        ),
      );
    res.statusCode = 404;
    html(page(bugs, hints, 'Not found', '<h1>Page not found</h1>'));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4300);
  const server = createShop({ bugs: process.env.BUGS ?? 'all', hints: process.env.HINTS === '1' });
  server.listen(port, '127.0.0.1', () => {
    console.log(
      `buggy-shop on http://localhost:${port}  bugs: ${process.env.BUGS ?? 'all'}  hints: ${process.env.HINTS === '1' ? 'on' : 'off'}`,
    );
  });
}
