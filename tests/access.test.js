import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AccessGate,
  accessConfig,
  hostAllowed,
  isPrivateAddress,
  targetAllowed,
} from '../src/server/access.js';
import { createServer } from '../src/server/app.js';

const shared = accessConfig({
  AIE2E_ACCESS_CODE: 'open-sesame-42',
  AIE2E_ALLOWED_HOSTS: 'aie2e-demo.onrender.com,*.trycloudflare.com',
  AIE2E_ALLOWED_TARGETS: 'Sauce Demo=http://localhost:4500, http://localhost:4300',
});
const resolveTo = (/** @type {string[]} */ ips) => async () => ips;

describe('a deployed (shared) instance', () => {
  it('accepts public host names only with an access code', () => {
    expect(hostAllowed('localhost:4173', accessConfig({}))).toBe(true);
    expect(
      hostAllowed(
        'aie2e-demo.onrender.com',
        accessConfig({ AIE2E_ALLOWED_HOSTS: 'aie2e-demo.onrender.com' }),
      ),
    ).toBe(false);
    expect(hostAllowed('aie2e-demo.onrender.com', shared)).toBe(true);
    expect(hostAllowed('abc-def.trycloudflare.com', shared)).toBe(true);
    expect(hostAllowed('evil.com', shared)).toBe(false);
    expect(hostAllowed('a.b.trycloudflare.com', shared)).toBe(false);
  });

  it('refuses targets on the owner’s machine or network, except listed ones', async () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(await targetAllowed('http://localhost:4500/', shared)).toEqual({ ok: true });
    expect((await targetAllowed('http://localhost:4173/api/health', shared)).ok).toBe(false);
    expect((await targetAllowed('http://169.254.169.254/latest', shared)).ok).toBe(false);
    // a public name that points at a private address is refused too
    expect(
      (await targetAllowed('https://sneaky.example', shared, resolveTo(['127.0.0.1']))).ok,
    ).toBe(false);
    expect(
      await targetAllowed('https://shop.example', shared, resolveTo(['93.184.216.34'])),
    ).toEqual({ ok: true });
  });

  it('checks the code in constant time and slows down guessing', () => {
    const gate = new AccessGate('open-sesame-42');
    const ok = gate.tryCode('open-sesame-42', 'a', true);
    expect(ok.ok).toBe(true);
    const cookie = ok.ok ? ok.cookie : '';
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    expect(gate.hasAccess(cookie.split(';')[0])).toBe(true);
    expect(gate.hasAccess('aie2e_access=nope')).toBe(false);
    for (let i = 0; i < 10; i++) expect(gate.tryCode('wrong', 'b').ok).toBe(false);
    const locked = gate.tryCode('open-sesame-42', 'b');
    expect(locked.ok === false && locked.retryAfterS).toBeGreaterThan(0);
  });

  it('locks the API behind the code and keeps the owner’s login and network off limits', async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'aie2e-shared-'));
    const { app } = await createServer({ outDir, access: shared });
    const host = { host: 'aie2e-demo.onrender.com' };
    try {
      const locked = await app.inject({ method: 'GET', url: '/api/runs', headers: host });
      expect(locked.statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/api/access', headers: host })).json(),
      ).toEqual({
        required: true,
        ok: false,
      });
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/access',
        headers: host,
        payload: { code: 'x' },
      });
      expect(wrong.statusCode).toBe(401);
      const right = await app.inject({
        method: 'POST',
        url: '/api/access',
        headers: host,
        payload: { code: 'open-sesame-42' },
      });
      const cookie = String(right.headers['set-cookie']).split(';')[0];
      const authed = { ...host, cookie };
      expect(
        (await app.inject({ method: 'GET', url: '/api/runs', headers: authed })).statusCode,
      ).toBe(200);
      const health = (
        await app.inject({ method: 'GET', url: '/api/health', headers: authed })
      ).json();
      expect(health.outDir).toBeUndefined();
      expect(health.shared).toEqual({
        maxTests: 4,
        apps: [
          { name: 'Sauce Demo', url: 'http://localhost:4500/' },
          { name: 'localhost:4300', url: 'http://localhost:4300/' },
        ],
      });

      const start = (/** @type {Record<string, unknown>} */ body) =>
        app.inject({
          method: 'POST',
          url: '/api/runs',
          headers: authed,
          payload: { plan: false, crawl: false, ...body },
        });
      const own = await start({ url: 'http://localhost:4173/' });
      expect(own.statusCode).toBe(403);
      expect(own.json().error).toMatch(/owner's machine or network/);
      const phish = await start({
        url: 'https://example.com/',
        auth: { loginUrl: 'https://example.com/login' },
      });
      expect(phish.statusCode).toBe(403);
      expect(phish.json().error).toMatch(/logging in/);
      // a saved suite cannot send the login elsewhere either
      const put = await app.inject({
        method: 'PUT',
        url: '/api/suites/sneaky',
        headers: authed,
        payload: {
          url: 'http://localhost:4500',
          auth: { loginUrl: 'https://example.com/login' },
          tests: [
            { title: 'Home', startUrl: '/', expectations: [{ kind: 'text-visible', text: 'x' }] },
          ],
        },
      });
      expect(put.statusCode).toBe(200);
      const viaSuite = await start({ url: 'http://localhost:4500/', suite: 'sneaky' });
      expect(viaSuite.statusCode).toBe(403);
      expect(viaSuite.json().error).toMatch(/logging in/);
    } finally {
      await app.close();
    }
  });
});
