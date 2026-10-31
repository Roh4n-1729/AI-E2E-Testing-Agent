import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Deploying the UI for others (docs/DEPLOY.md). It launches browsers on this machine with the owner's
 * API key, so a shared instance needs three guards on top of the local-only defaults:
 *   1. an access code (AIE2E_ACCESS_CODE) for every API call and run file; without it no public host
 *      name is accepted at all;
 *   2. targets on this machine or its network are refused (the server must not become a way into the
 *      owner's network or the cloud's metadata service), except origins listed in AIE2E_ALLOWED_TARGETS
 *      (the demo apps started next to it);
 *   3. logging in with the owner's .env account only on those listed origins, so a visitor cannot
 *      point the login at their own page and capture the password.
 */

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const COOKIE = 'aie2e_access';

/**
 * @typedef {{
 *   code: string | undefined,
 *   shared: boolean,
 *   allowedHosts: RegExp[],
 *   allowedTargets: string[],
 *   apps: { name: string, url: string }[],
 *   maxTests: number,
 * }} AccessConfig
 */

/** @param {NodeJS.ProcessEnv} [env] @returns {AccessConfig} */
export function accessConfig(env = process.env) {
  const code = env.AIE2E_ACCESS_CODE?.trim() || undefined;
  const list = (/** @type {string | undefined} */ v) =>
    String(v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const apps = list(env.AIE2E_ALLOWED_TARGETS).flatMap((entry) => {
    const [name, url] = entry.includes('=') ? entry.split(/=(.*)/s) : ['', entry];
    try {
      const u = new URL(url.trim());
      return [{ name: name.trim() || u.host, url: u.toString() }];
    } catch {
      return [];
    }
  });
  return {
    code,
    shared: !!code,
    // "*.trycloudflare.com" -> any one label in front of trycloudflare.com
    allowedHosts: list(env.AIE2E_ALLOWED_HOSTS).map(
      (h) =>
        new RegExp(
          `^${h
            .toLowerCase()
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[a-z0-9-]+')}(:\\d+)?$`,
        ),
    ),
    // "Sauce Demo=http://localhost:4500": the name is shown in the UI as a ready-made target
    apps,
    allowedTargets: apps.map((a) => new URL(a.url).origin),
    maxTests: Math.max(1, Math.min(8, Number(env.AIE2E_SHARED_MAX_TESTS) || 4)),
  };
}

/**
 * Local hosts always; a public host name only when an access code protects the server.
 * @param {string} host @param {AccessConfig} cfg
 */
export function hostAllowed(host, cfg) {
  const h = host.toLowerCase();
  if (LOCAL_HOSTS.test(h)) return true;
  return !!cfg.code && cfg.allowedHosts.some((re) => re.test(h));
}

/** Loopback, private, link-local and other addresses that are not on the public internet. @param {string} ip */
export function isPrivateAddress(ip) {
  const v = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(v) === 6) {
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  return false;
}

/**
 * May a shared instance open this URL? Listed origins always; anything that resolves to a private
 * address never. Every address the name resolves to is checked, so a public name pointing at
 * 127.0.0.1 is refused too.
 * @param {string} url @param {AccessConfig} cfg
 * @param {(host: string) => Promise<string[]>} [resolve]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function targetAllowed(url, cfg, resolve = defaultResolve) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'Not a valid URL' };
  }
  if (cfg.allowedTargets.includes(u.origin)) return { ok: true };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local =
    /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) ||
    (isIP(host)
      ? isPrivateAddress(host)
      : (await resolve(host).catch(() => [])).some(isPrivateAddress));
  return local
    ? {
        ok: false,
        reason: `This shared instance does not open addresses on the owner's machine or network (${u.host}).`,
      }
    : { ok: true };
}

/** @param {string} host */
async function defaultResolve(host) {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/**
 * The access code check: a cookie set after the code is entered once, compared in constant time,
 * with a cap on wrong guesses per visitor.
 */
export class AccessGate {
  /** @param {string} code */
  constructor(code) {
    this.secret = randomBytes(32);
    this.token = this.#sign(code);
    /** @type {Map<string, { n: number, until: number }>} */
    this.failures = new Map();
  }

  /** @param {string} value */
  #sign(value) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }

  /** @param {string | undefined} cookieHeader */
  hasAccess(cookieHeader) {
    const value = parseCookie(cookieHeader)[COOKIE];
    return !!value && safeEqual(value, this.token);
  }

  /**
   * @param {string} code @param {string} who  the visitor (IP)
   * @returns {{ ok: true, cookie: string } | { ok: false, retryAfterS?: number }}
   */
  tryCode(code, who, secure = false, now = Date.now()) {
    const f = this.failures.get(who);
    if (f && f.n >= 10 && f.until > now)
      return { ok: false, retryAfterS: Math.ceil((f.until - now) / 1000) };
    if (safeEqual(this.#sign(String(code ?? '')), this.token)) {
      this.failures.delete(who);
      return {
        ok: true,
        cookie: `${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`,
      };
    }
    const next =
      f && f.until > now ? { n: f.n + 1, until: f.until } : { n: 1, until: now + 10 * 60_000 };
    this.failures.set(who, next);
    return { ok: false };
  }
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** @param {string | undefined} header @returns {Record<string, string>} */
function parseCookie(header) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
