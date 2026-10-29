import { differenceCiede2000, parse } from 'culori';
import { JND } from './audit.js';

/**
 * @import { Consistency, ConsistencyFinding, ConsistencyStyle, InventoryEntry, TestResult } from '../core/types.js'
 */

const deltaE = differenceCiede2000();
const COLOR_PROPS = new Set(['color', 'background', 'border']);
/** How far two values may be apart and still look like "the same thing, slightly off". */
const SMALL = {
  /** ΔE00 above the just-noticeable difference but below this: a near-identical colour */
  color: 10,
  radius: 2,
  fontSize: 1,
  padding: 2,
  fontWeight: 100,
};

/**
 * Do two looks of the same kind of element differ only slightly (probably meant to be one)?
 * Returns the differences, or null when they are identical or clearly deliberate variants
 * (a different font, a very different colour, a missing border...).
 * @param {Record<string, string>} a @param {Record<string, string>} b
 * @returns {{ prop: string, a: string, b: string, deltaE?: number }[] | null}
 */
export function nearDuplicate(a, b) {
  /** @type {{ prop: string, a: string, b: string, deltaE?: number }[]} */
  const diffs = [];
  for (const prop of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[prop];
    const y = b[prop];
    if (x === y) continue;
    if (x === undefined || y === undefined) return null; // one has a background or border, one has not
    if (COLOR_PROPS.has(prop)) {
      const cx = parse(x);
      const cy = parse(y);
      if (!cx || !cy) return null;
      const d = Math.round(deltaE(cx, cy) * 10) / 10;
      if (d <= JND) continue; // looks the same
      if (d > SMALL.color) return null;
      diffs.push({ prop, a: x, b: y, deltaE: d });
    } else if (prop === 'fontFamily') {
      return null;
    } else if (prop === 'padding') {
      const [xt = 0, xl = 0] = x.split(' ').map(parseFloat);
      const [yt = 0, yl = 0] = y.split(' ').map(parseFloat);
      if (Math.abs(xt - yt) > SMALL.padding || Math.abs(xl - yl) > SMALL.padding) return null;
      diffs.push({ prop, a: x, b: y });
    } else {
      const limit = SMALL[/** @type {keyof typeof SMALL} */ (prop)];
      const dx = Math.abs(parseFloat(x) - parseFloat(y));
      if (limit === undefined || Number.isNaN(dx) || dx > limit) return null;
      diffs.push({ prop, a: x, b: y });
    }
  }
  return diffs.length ? diffs : null;
}

/** @param {string} url */
const routeOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.hash.startsWith('#/') ? u.hash : ''}`;
  } catch {
    return url;
  }
};

/**
 * Across every distinct screen the run audited: do the same kinds of element look the same?
 *  - near-duplicate: two looks of one kind (button, link, input, h1..h6) that differ only slightly,
 *    e.g. #2563eb vs #2f6fe4, or 6px vs 7px corners: drift, not design;
 *  - component-variants: an element the app names with data-aie2e-component renders in more than one way.
 * Advisory only: it never changes a verdict.
 * @param {TestResult[]} results
 * @returns {Consistency}
 */
export function analyseConsistency(results) {
  /** one entry per screen: reused states point at an audit already counted */
  /** @type {Map<string, { url: string, themes: { id: string, inventory: InventoryEntry[] }[] }>} */
  const screens = new Map();
  for (const r of results)
    for (const st of r.evidence.themeStates ?? [])
      if (!st.reusedFrom && st.audit.themes.length && !screens.has(st.key))
        screens.set(st.key, {
          url: st.url,
          themes: st.audit.themes.map((t) => ({ id: t.id, inventory: t.inventory ?? [] })),
        });

  /** theme -> look key -> merged look */
  /** @type {Map<string, Map<string, ConsistencyStyle & { kind: string, component?: string, variant?: string }>>} */
  const looks = new Map();
  for (const sc of screens.values())
    for (const th of sc.themes) {
      const byKey = looks.get(th.id) ?? new Map();
      looks.set(th.id, byKey);
      for (const e of th.inventory) {
        const key = `${e.kind}|${e.component ?? ''}|${e.variant ?? ''}|${JSON.stringify(e.style)}`;
        const m = byKey.get(key) ?? {
          kind: e.kind,
          component: e.component,
          variant: e.variant,
          style: e.style,
          count: 0,
          pages: [],
          example: e.example,
        };
        m.count += e.count;
        const route = routeOf(sc.url);
        if (!m.pages.includes(route)) m.pages.push(route);
        byKey.set(key, m);
      }
    }

  /** @type {ConsistencyFinding[]} */
  const findings = [];
  const strip = (/** @type {any} */ m) => ({
    style: m.style,
    count: m.count,
    pages: m.pages,
    example: m.example,
  });
  for (const [theme, byKey] of looks) {
    const all = [...byKey.values()];
    // 1. named components must look the same everywhere (per variant)
    /** @type {Map<string, typeof all>} */
    const named = new Map();
    for (const m of all)
      if (m.component) {
        const k = `${m.component}|${m.variant ?? ''}`;
        named.set(k, [...(named.get(k) ?? []), m]);
      }
    for (const group of named.values()) {
      if (group.length < 2) continue;
      const [a, b] = group;
      findings.push({
        type: 'component-variants',
        theme,
        kind: a?.kind ?? 'component',
        component: a?.component,
        styles: group.map(strip),
        diffs: a && b ? (nearDuplicate(a.style, b.style) ?? styleDiff(a.style, b.style)) : [],
        message: `${theme}: component "${a?.component}" renders ${group.length} different ways`,
      });
    }
    // 2. near-identical looks of the same kind of element
    const unnamed = all.filter((m) => !m.component);
    for (let i = 0; i < unnamed.length; i++)
      for (let j = i + 1; j < unnamed.length; j++) {
        const a = /** @type {(typeof all)[number]} */ (unnamed[i]);
        const b = /** @type {(typeof all)[number]} */ (unnamed[j]);
        if (a.kind !== b.kind || (a.variant ?? '') !== (b.variant ?? '')) continue;
        const diffs = nearDuplicate(a.style, b.style);
        if (!diffs) continue;
        findings.push({
          type: 'near-duplicate',
          theme,
          kind: a.kind,
          styles: [strip(a), strip(b)],
          diffs,
          message: `${theme}: two near-identical ${a.kind} styles (${diffs
            .map(
              (d) =>
                `${d.prop} ${d.a} vs ${d.b}${d.deltaE !== undefined ? `, ΔE ${d.deltaE}` : ''}`,
            )
            .join('; ')})`,
        });
      }
  }
  return {
    states: screens.size,
    themes: [...looks.keys()],
    findings: findings.slice(0, 30),
  };
}

/** @param {Record<string, string>} a @param {Record<string, string>} b */
function styleDiff(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((p) => a[p] !== b[p])
    .map((prop) => ({ prop, a: a[prop] ?? 'none', b: b[prop] ?? 'none' }));
}
