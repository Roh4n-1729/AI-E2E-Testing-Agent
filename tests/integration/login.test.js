import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LoginError, performLogin } from '../../src/auth/login.js';
import { startRun } from '../../src/app/startRun.js';
import { BrowserSession } from '../../src/browser/session.js';
import { RunArtifacts } from '../../src/storage/artifacts.js';
import { silentLogger } from '../../src/util/logger.js';
import { hasChromium, testConfig } from './harness.js';

const PASSWORD = 'correct-horse-7';

/** A small app with a real session: an HttpOnly cookie plus a localStorage value. */
const app = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const loggedIn = /(^|;\s*)sid=valid/.test(req.headers.cookie ?? '');
  res.setHeader('content-type', 'text/html');
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { email, password } = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      if (email === 'ada@example.com' && password === PASSWORD) {
        res.setHeader('set-cookie', 'sid=valid; HttpOnly; Path=/; SameSite=Lax');
        res.end('{"ok":true}');
      } else {
        res.statusCode = 401;
        res.end('{"ok":false}');
      }
    });
    return;
  }
  const script = `<script>
async function signIn(){const r=await fetch('/api/login',{method:'POST',body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('pw').value})});
if(r.ok){localStorage.setItem('user','ada');location.href='/account'}else{document.getElementById('err').textContent='Wrong email or password'}}</script>`;
  if (url.pathname === '/login')
    return void res.end(`<!doctype html><title>Sign in</title><h1>Sign in</h1>
<form onsubmit="event.preventDefault();signIn()"><label>Email <input id="email" type="email" autocomplete="username"></label>
<label>Password <input id="pw" type="password"></label><button type="submit">Sign in</button></form><p id="err" role="alert"></p>${script}`);
  if (url.pathname === '/login2')
    // two screens: email + Next, then the password appears
    return void res.end(`<!doctype html><title>Sign in</title><h1>Sign in</h1>
<div id="s1"><input id="email" type="email" placeholder="Email"><button onclick="document.getElementById('s1').hidden=true;document.getElementById('s2').hidden=false">Next</button></div>
<div id="s2" hidden><input id="pw" type="password"><button onclick="signIn()">Sign in</button></div><p id="err" role="alert"></p>${script}`);
  if (url.pathname === '/account') {
    if (!loggedIn) {
      res.statusCode = 302;
      res.setHeader('location', '/login');
      return void res.end();
    }
    return void res.end(`<!doctype html><title>Account</title><h1>Welcome, Ada</h1><p id="ls"></p>
<script>document.getElementById('ls').textContent='Stored: '+localStorage.getItem('user')</script>`);
  }
  res.end('<!doctype html><title>Home</title><h1>Home</h1>');
});

/** @type {string} */
let base;
const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-login-'));
const cfg = testConfig({ outDir: out });
beforeAll(async () => {
  await new Promise((r) => app.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (app.address()).port}`;
});
afterAll(() => app.close());
const setCreds = (/** @type {string} */ pw) => {
  process.env.AIE2E_USERNAME = 'ada@example.com';
  process.env.AIE2E_PASSWORD = pw;
};
afterEach(() => {
  delete process.env.AIE2E_USERNAME;
  delete process.env.AIE2E_PASSWORD;
});

describe.skipIf(!hasChromium)('login flows', () => {
  it('logs in once with the form it finds, and a test session starts logged in (cookie + localStorage)', async () => {
    setCreds(PASSWORD);
    const login = await performLogin({
      appUrl: base,
      auth: { loginUrl: '/login', usernameEnv: 'AIE2E_USERNAME', passwordEnv: 'AIE2E_PASSWORD' },
      cfg,
      logger: silentLogger,
    });
    expect(login.landedOn).toContain('/account');
    expect(login.state.cookies.map((c) => c.name)).toContain('sid');

    const s = await BrowserSession.open(
      cfg,
      new RunArtifacts(out, 'r1').forTest('t'),
      silentLogger,
      {
        storageState: login.state,
      },
    );
    try {
      await s.goto(`${base}/account`);
      expect(await s.page.textContent('h1')).toBe('Welcome, Ada');
      expect(await s.page.textContent('#ls')).toBe('Stored: ada');
    } finally {
      await s.close();
    }
  });

  it('handles "email, Next, then password" and exact steps with placeholders', async () => {
    setCreds(PASSWORD);
    const twoStep = await performLogin({
      appUrl: base,
      auth: {
        loginUrl: '/login2',
        successText: 'Welcome, Ada',
        usernameEnv: 'AIE2E_USERNAME',
        passwordEnv: 'AIE2E_PASSWORD',
      },
      cfg,
      logger: silentLogger,
    });
    expect(twoStep.landedOn).toContain('/account');
    const scripted = await performLogin({
      appUrl: base,
      auth: {
        loginUrl: '/login',
        successUrl: '/account',
        usernameEnv: 'AIE2E_USERNAME',
        passwordEnv: 'AIE2E_PASSWORD',
        steps: [
          {
            kind: 'act',
            description: 'Email',
            selector: '#email',
            method: 'fill',
            arguments: ['{{username}}'],
          },
          {
            kind: 'act',
            description: 'Password',
            selector: '#pw',
            method: 'fill',
            arguments: ['{{password}}'],
          },
          { kind: 'act', description: 'Sign in', selector: 'button[type=submit]', method: 'click' },
        ],
      },
      cfg,
      logger: silentLogger,
    });
    expect(scripted.state.cookies.some((c) => c.name === 'sid')).toBe(true);
  });

  it('a wrong password stops with a clear reason and a screenshot; missing credentials say where to put them', async () => {
    setCreds('wrong');
    const shot = path.join(out, 'login-failed.png');
    const err = await performLogin({
      appUrl: base,
      auth: { loginUrl: '/login', usernameEnv: 'AIE2E_USERNAME', passwordEnv: 'AIE2E_PASSWORD' },
      cfg,
      logger: silentLogger,
      screenshot: shot,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect(err.message).toBe('Login as ada@example.com failed: the login form is still there');
    expect(existsSync(shot)).toBe(true);

    delete process.env.AIE2E_PASSWORD;
    const missing = await performLogin({
      appUrl: base,
      auth: { loginUrl: '/login', usernameEnv: 'AIE2E_USERNAME', passwordEnv: 'AIE2E_PASSWORD' },
      cfg,
      logger: silentLogger,
    }).catch((e) => e);
    expect(missing.message).toMatch(/AIE2E_USERNAME and AIE2E_PASSWORD.*\.env/);
  });

  it('a suite with "auth" runs its tests logged in, and the password appears nowhere in the report', async () => {
    setCreds(PASSWORD);
    const suiteFile = path.join(out, 'account.suite.json');
    writeFileSync(
      suiteFile,
      JSON.stringify({
        auth: { loginUrl: '/login', successText: 'Welcome, Ada' },
        tests: [
          {
            title: 'Account page shows the user',
            startUrl: '/account',
            expectations: [{ kind: 'text-visible', text: 'Welcome, Ada' }],
          },
        ],
      }),
    );
    const { report, runId } = await startRun({
      url: base,
      suite: suiteFile,
      outDir: out,
      visual: 'off',
      quality: 'off',
    });
    expect(report.summary.passed).toBe(1);
    expect(report.auth).toMatchObject({ username: 'ada@example.com' });
    const json = readFileSync(path.join(out, 'runs', runId, 'report.json'), 'utf8');
    const html = readFileSync(path.join(out, 'runs', runId, 'report.html'), 'utf8');
    expect(json).not.toContain(PASSWORD);
    expect(html).not.toContain(PASSWORD);
  });
});
