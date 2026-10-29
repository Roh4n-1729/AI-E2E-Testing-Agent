import { createHash, randomBytes } from 'node:crypto';

/** @param {string} input @param {number} [max] */
export function slugify(input, max = 48) {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'test';
}

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/** @param {string} input */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** @param {unknown} e */
export function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run `fn` over items with at most `limit` in flight; preserves input order.
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapPool(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(/** @type {T} */ (items[i]), i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Counting semaphore: `run(fn)` starts fn when fewer than `limit` are in flight.
 * @param {number} limit
 */
export function createLimiter(limit) {
  let active = 0;
  /** @type {(() => void)[]} */
  const queue = [];
  const next = () => {
    if (active >= limit) return;
    const start = queue.shift();
    if (start) {
      active++;
      start();
    }
  };
  return {
    /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push(() =>
          fn()
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            }),
        );
        next();
      });
    },
  };
}

/** Escape text for safe inclusion in HTML. @param {unknown} s */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
