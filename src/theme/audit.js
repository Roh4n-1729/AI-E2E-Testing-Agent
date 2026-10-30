import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { differenceCiede2000, formatHex, parse } from 'culori';
import { getAxe } from '../browser/collectors.js';
import { applyTheme, discoverThemes, restoreTheme, themeState } from './discover.js';

/**
 * @import { Page } from 'playwright'
 * @import { ThemeDef } from './discover.js'
 * @import { ThemeAudit, ThemeFinding, ThemeResult } from '../core/types.js'
 */

const deltaE = differenceCiede2000();
/** Below this CIEDE2000 distance two colours look the same to people ("just noticeable difference"). */
export const JND = 2.3;
const CATEGORIES = /** @type {const} */ ([
  'color',
  'background',
  'border',
  'radius',
  'fontSize',
  'fontFamily',
]);
/** CSS properties that can produce each category, for the "which rule set it" lookup. */
const DECLARING = {
  color: ['color'],
  background: ['background-color', 'background'],
  border: ['border-top-color', 'border-color', 'border-top', 'border'],
  radius: ['border-top-left-radius', 'border-radius'],
  fontSize: ['font-size', 'font'],
  fontFamily: ['font-family', 'font'],
};
const INHERITED = new Set(['color', 'fontSize', 'fontFamily']);

/**
 * Runs in the page: tag visible elements that show a themable value and return their geometry.
 * Tags (data-aie2e-probe) stay until the audit ends, so the SAME elements are compared in every theme.
 * @param {number} max
 */
function tagElements(max) {
  /** @type {{ i: number, tag: string, sel: string, text: string, w: number, h: number, area: number, inView: boolean, kind: string, component: string, variant: string }[]} */
  const out = [];
  const vh = innerHeight;
  const vw = innerWidth;
  /** what a person would call this element; '' = not part of the component inventory */
  const kindOf = (/** @type {Element} */ el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (/^h[1-6]$/.test(tag)) return tag;
    if (
      tag === 'button' ||
      role === 'button' ||
      (tag === 'input' && /^(button|submit|reset)$/.test(/** @type {HTMLInputElement} */ (el).type))
    )
      return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'input';
    return '';
  };
  /** states that legitimately look different (disabled, selected...) are compared separately */
  const variantOf = (/** @type {Element} */ el) =>
    [
      el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : '',
      el.getAttribute('aria-pressed') === 'true' ? 'pressed' : '',
      el.getAttribute('aria-selected') === 'true' ? 'selected' : '',
      el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false'
        ? 'current'
        : '',
      el.getAttribute('aria-expanded') === 'true' ? 'expanded' : '',
    ]
      .filter(Boolean)
      .join(' ');
  const short = (/** @type {Element} */ el) => {
    const parts = [];
    for (
      let n = /** @type {Element | null} */ (el), d = 0;
      n && n !== document.body && d < 3;
      n = n.parentElement, d++
    ) {
      let s = n.tagName.toLowerCase();
      const tid = n.getAttribute('data-testid');
      if (tid) {
        parts.unshift(`[data-testid="${tid}"]`);
        break;
      }
      if (n.id && !/\d{3,}|:/.test(n.id)) {
        parts.unshift(`#${n.id}`);
        break;
      }
      const cls = Array.from(n.classList)
        .filter((c) => !c.includes(':') && c.length < 24)
        .slice(0, 2);
      if (cls.length) s += `.${cls.join('.')}`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (out.length >= max) break;
    if (
      el.closest(
        '#__aie2e_cursor, svg, script, style, noscript, template, [data-aie2e-ignore-theme]',
      )
    )
      continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > vh * 3) continue;
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    )
      continue;
    const i = out.length;
    el.setAttribute('data-aie2e-probe', String(i));
    const ownText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim(),
    );
    const component = el.getAttribute('data-aie2e-component') ?? '';
    const kind = kindOf(el) || (component ? 'component' : '');
    out.push({
      i,
      tag: el.tagName.toLowerCase(),
      sel: short(el),
      text: (ownText || kind ? (el.textContent ?? '') : '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 40),
      w: r.width,
      h: r.height,
      area: r.width * r.height,
      inView: r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw,
      kind,
      component,
      variant: kind ? variantOf(el) : '',
    });
  }
  return out;
}

/** Runs in the page: the themable values of every tagged element, in the CURRENT theme. */
function readProbes() {
  /** @type {Record<number, Record<string, string>>} */
  const out = {};
  for (const el of Array.from(document.querySelectorAll('[data-aie2e-probe]'))) {
    const cs = getComputedStyle(el);
    const ownText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim(),
    );
    /** @type {Record<string, string>} */
    const p = {};
    if (ownText) {
      p.color = cs.color;
      p.fontSize = cs.fontSize;
      p.fontFamily = cs.fontFamily;
    }
    const transparent = (/** @type {string} */ c) =>
      c === 'transparent' || /^rgba\([^)]*,\s*0(\.0+)?\)$|\/\s*0(\.0+)?\)$/.test(c);
    if (!transparent(cs.backgroundColor)) p.background = cs.backgroundColor;
    if (
      parseFloat(cs.borderTopWidth) > 0 &&
      cs.borderTopStyle !== 'none' &&
      !transparent(cs.borderTopColor)
    )
      p.border = cs.borderTopColor;
    if (parseFloat(cs.borderTopLeftRadius) > 0 && (p.background || p.border))
      p.radius = cs.borderTopLeftRadius;
    out[Number(el.getAttribute('data-aie2e-probe'))] = p;
  }
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const page =
    /^rgba\([^)]*,\s*0(\.0+)?\)$/.test(bodyBg) || bodyBg === 'transparent'
      ? getComputedStyle(document.documentElement).backgroundColor
      : bodyBg;
  return { values: out, page };
}

/**
 * Runs in the page: the full look of the inventory elements (buttons, links, inputs, headings, named
 * components) in the CURRENT theme, for the cross-page consistency check. Elements that are hovered,
 * focused or pressed right now are skipped: their look is a momentary state, not their design.
 * @param {number[]} indices
 */
function readStyles(indices) {
  /** @type {Record<number, Record<string, string>>} */
  const out = {};
  const transparent = (/** @type {string} */ c) =>
    c === 'transparent' || /^rgba\([^)]*,\s*0(\.0+)?\)$|\/\s*0(\.0+)?\)$/.test(c);
  for (const i of indices) {
    const el = document.querySelector(`[data-aie2e-probe="${i}"]`);
    if (!el || el.matches(':hover, :focus, :active')) continue;
    const cs = getComputedStyle(el);
    /** @type {Record<string, string>} */
    const st = {
      color: cs.color,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontFamily: (cs.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim().toLowerCase(),
    };
    if (!transparent(cs.backgroundColor)) st.background = cs.backgroundColor;
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none')
      st.border = cs.borderTopColor;
    if (st.background || st.border) {
      st.radius = cs.borderTopLeftRadius;
      st.padding = `${cs.paddingTop} ${cs.paddingLeft}`;
    }
    out[i] = st;
  }
  return out;
}

/** Runs in the page: resolve every token in the CURRENT theme to a colour, a length or a font list. */
export function resolveTokens(/** @type {string[]} */ names) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;color:rgb(1, 2, 3);';
  const probe = document.createElement('div');
  host.appendChild(probe);
  document.body.appendChild(host);
  /** @type {{ name: string, value: string }[]} */
  const colors = [];
  /** @type {{ name: string, px: number }[]} */
  const lengths = [];
  /** @type {{ name: string, family: string }[]} */
  const fonts = [];
  const root = getComputedStyle(document.documentElement);
  for (const name of names) {
    const raw = root.getPropertyValue(name).trim();
    if (!raw) continue;
    probe.style.cssText = `color: var(${name})`;
    let c = getComputedStyle(probe).color;
    if (c === 'rgb(1, 2, 3)') {
      probe.style.cssText = `color: hsl(var(${name}))`; // shadcn v3 style: "222 47% 11%"
      c = getComputedStyle(probe).color;
    }
    if (c !== 'rgb(1, 2, 3)') {
      colors.push({ name, value: c });
      continue;
    }
    if (/^-?[\d.]+(px|rem|em)$|^calc\(/.test(raw)) {
      probe.style.cssText = `margin-left: var(${name})`;
      lengths.push({ name, px: parseFloat(getComputedStyle(probe).marginLeft) });
      continue;
    }
    if (
      /,|["']|sans-serif|serif|monospace|system-ui/.test(raw) &&
      !/\d/.test(raw.split(',')[0] ?? '')
    ) {
      fonts.push({
        name,
        family: (raw.split(',')[0] ?? '').replace(/["']/g, '').trim().toLowerCase(),
      });
    }
  }
  host.remove();
  return { colors, lengths, fonts };
}

/**
 * Audit the page as it is now, in every theme the build ships.
 * `scrollSafe` is for audits in the middle of a run: element crops are only taken of elements already
 * in view (a crop of anything else would scroll the page), and the scroll position is restored, so the
 * page the agent saw in its last screenshot is still the page it acts on.
 * @param {Page} page
 * @param {{ dir: string, rel: (abs: string) => string, maxElements?: number, crops?: number, scrollSafe?: boolean, reference?: import('../core/types.js').ThemeReference }} opts
 *   reference: audit against ANOTHER product's themes (cross-product conformance) instead of the page's own
 * @returns {Promise<ThemeAudit>}
 */
export async function auditThemes(
  page,
  { dir, rel, maxElements = 400, crops = 6, scrollSafe = false, reference },
) {
  const found = await discoverThemes(page);
  // Against a reference product the target's own variables do not matter (it may have none at all):
  // every value is compared with the reference's tokens, theme by theme.
  const discovery =
    reference && !found.themes.length
      ? {
          ...found,
          themes: [
            /** @type {ThemeDef} */ ({ id: 'default', switch: { type: 'base' }, overrides: {} }),
          ],
        }
      : found;
  if (!discovery.themes.length || (!reference && !discovery.tokenNames.length)) {
    return {
      themes: [],
      tokenCount: discovery.tokenNames.length,
      skippedSheets: discovery.skippedSheets,
    };
  }
  const original = await themeState(page);
  const scroll = await page.evaluate(() => [scrollX, scrollY]).catch(() => [0, 0]);
  const cdp = await page.context().newCDPSession(page);
  /** @type {Map<string, { sourceURL: string, startLine: number, isInline: boolean }>} */
  const sheets = new Map();
  cdp.on('CSS.styleSheetAdded', (e) => sheets.set(e.header.styleSheetId, e.header));
  await mkdir(dir, { recursive: true });
  let cropsLeft = crops;
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const elements = await page.evaluate(tagElements, maxElements);
    const meta = new Map(elements.map((e) => [e.i, e]));
    const inventoryIdx = elements.filter((e) => e.kind).map((e) => e.i);
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    /** @type {Map<string, Declaration | null>} */
    const declCache = new Map();
    const declarationOf = async (
      /** @type {number} */ i,
      /** @type {typeof CATEGORIES[number]} */ cat,
    ) => {
      const key = `${i}|${cat}`;
      if (!declCache.has(key))
        declCache.set(
          key,
          await findDeclaration(cdp, root.nodeId, i, cat, sheets).catch(() => null),
        );
      return declCache.get(key) ?? null;
    };

    /** @type {ThemeResult[]} */
    const results = [];
    /** @type {Map<string, { values: Record<number, Record<string, string>>, page: string }>} */
    const perTheme = new Map();
    for (const theme of discovery.themes) {
      await applyTheme(page, theme, discovery.themes);
      const tokens = reference
        ? referenceTokens(reference, theme.id)
        : await page.evaluate(resolveTokens, discovery.tokenNames);
      const snap = await page.evaluate(readProbes);
      perTheme.set(theme.id, snap);
      const styles = inventoryIdx.length ? await page.evaluate(readStyles, inventoryIdx) : {};
      const shot = path.join(dir, `${theme.id}.png`);
      await page.screenshot({ path: shot }).catch(() => undefined);

      /** @type {Map<string, ThemeFinding>} */
      const findings = new Map();
      /** @type {Record<string, { checked: number, on: number }>} */
      const categories = {};
      let checked = 0;
      let on = 0;
      const radiusTokens = tokens.lengths.filter((t) => /radius|rounded/i.test(t.name));
      const sizeTokens = tokens.lengths.filter(
        (t) =>
          /text|font-size|fontsize|fs-|size/i.test(t.name) && !/line|leading|spacing/i.test(t.name),
      );
      const colorTokens = tokens.colors
        .map((t) => ({ ...t, parsed: parse(t.value) }))
        .filter((t) => t.parsed);

      for (const [idx, props] of Object.entries(snap.values)) {
        const i = Number(idx);
        const m = meta.get(i);
        if (!m) continue;
        for (const cat of CATEGORIES) {
          const value = props[cat];
          if (!value) continue;
          const match = matchValue(cat, value, m, {
            colorTokens,
            radiusTokens,
            sizeTokens,
            fonts: tokens.fonts,
          });
          if (match === null) continue; // the theme defines no tokens for this category
          categories[cat] ??= { checked: 0, on: 0 };
          categories[cat].checked++;
          checked++;
          if (match.ok) {
            categories[cat].on++;
            on++;
            continue;
          }
          // Off-theme by value. Ask Chrome which rule produced it: a var() means it is derived from the
          // theme (e.g. calc(var(--radius) - 2px)), which is fine.
          const decl = await declarationOf(i, cat);
          if (decl?.usesVar && !reference) {
            categories[cat].on++;
            on++;
            continue;
          }
          const key = `${cat}|${match.display}`;
          const f = findings.get(key) ?? {
            category: cat,
            value: match.display,
            count: 0,
            kind: reference
              ? 'off-reference'
              : decl?.origin === 'user-agent'
                ? 'browser-default'
                : decl
                  ? 'hard-coded'
                  : 'off-theme',
            nearest: match.nearest,
            declaration: decl
              ? { value: decl.value, source: decl.source, selector: decl.selector }
              : undefined,
            examples: [],
          };
          f.count++;
          if (f.examples.length < 3) f.examples.push({ selector: m.sel, text: m.text });
          if (!f.crop && cropsLeft > 0 && (!scrollSafe || m.inView)) {
            const file = path.join(dir, `${theme.id}-${cat}-${findings.size}.png`);
            const ok = await page
              .locator(`[data-aie2e-probe="${i}"]`)
              .screenshot({ path: file, timeout: 2000 })
              .then(() => true)
              .catch(() => false);
            if (ok) {
              f.crop = rel(file);
              cropsLeft--;
            }
          }
          findings.set(key, f);
        }
      }
      results.push({
        id: theme.id,
        switch: describeSwitch(theme),
        tokens: {
          colors: tokens.colors.length,
          lengths: tokens.lengths.length,
          fonts: tokens.fonts.length,
        },
        checked,
        onTheme: on,
        score: checked ? on / checked : null,
        categories,
        findings: [...findings.values()].sort((a, b) => b.count - a.count).slice(0, 25),
        leaks: [],
        contrastIssues: await contrastIssues(page),
        screenshot: rel(shot),
        inventory: inventoryOf(styles, meta),
      });
    }

    // Leaks: a large surface whose background is identical in every theme although the page background
    // changed between them, e.g. a white card that stays white in dark mode.
    if (results.length > 1) {
      const ids = results.map((r) => r.id);
      const pages = ids.map((id) => perTheme.get(id)?.page);
      const pageChanged = new Set(pages).size > 1;
      if (pageChanged) {
        const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
        for (const [i, m] of meta) {
          if (m.area < viewport.width * viewport.height * 0.01) continue;
          const bgs = ids.map((id) => perTheme.get(id)?.values[i]?.background);
          if (!bgs[0] || bgs.some((b) => b !== bgs[0])) continue;
          // reported on every theme except the default one, where the value is (by definition) at home
          for (const r of results.slice(1)) {
            const decl = await declarationOf(i, 'background');
            if (decl?.usesVar) continue; // a theme token that happens to be equal in both themes
            if (r.leaks.length < 10)
              r.leaks.push({
                selector: m.sel,
                text: m.text,
                value: toHex(bgs[0]),
                source: decl?.source,
              });
          }
        }
      }
    }
    return {
      themes: results,
      tokenCount: reference ? referenceTokenCount(reference) : discovery.tokenNames.length,
      skippedSheets: discovery.skippedSheets,
      ...(reference ? { reference: reference.url } : {}),
    };
  } finally {
    await page
      .evaluate(() =>
        document
          .querySelectorAll('[data-aie2e-probe]')
          .forEach((e) => e.removeAttribute('data-aie2e-probe')),
      )
      .catch(() => undefined);
    await restoreTheme(page, original).catch(() => undefined);
    if (scrollSafe)
      await page.evaluate(([x, y]) => scrollTo(x ?? 0, y ?? 0), scroll).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * Group the inventory elements by what they are and exactly how they look (colours as hex).
 * @param {Record<number, Record<string, string>>} styles
 * @param {Map<number, { sel: string, text: string, kind: string, component: string, variant: string }>} meta
 * @returns {import('../core/types.js').InventoryEntry[]}
 */
function inventoryOf(styles, meta) {
  /** @type {Map<string, import('../core/types.js').InventoryEntry>} */
  const groups = new Map();
  for (const [idx, raw] of Object.entries(styles)) {
    const m = meta.get(Number(idx));
    if (!m) continue;
    /** @type {Record<string, string>} */
    const style = {};
    for (const k of Object.keys(raw).sort()) {
      const v = raw[k] ?? '';
      style[k] = k === 'color' || k === 'background' || k === 'border' ? toHex(v) : v;
    }
    const key = `${m.kind}|${m.component}|${m.variant}|${JSON.stringify(style)}`;
    const g = groups.get(key) ?? {
      kind: m.kind,
      component: m.component || undefined,
      variant: m.variant || undefined,
      style,
      count: 0,
      example: { selector: m.sel, text: m.text },
    };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 80);
}

/**
 * The reference product's tokens for one of the target's themes: same id (light ↔ light, dark ↔ dark),
 * else the reference's base theme.
 * @param {import('../core/types.js').ThemeReference} ref @param {string} id
 */
function referenceTokens(ref, id) {
  const t = ref.themes.find((x) => x.id === id) ?? ref.themes[0];
  return t ? t.tokens : { colors: [], lengths: [], fonts: [] };
}
/** @param {import('../core/types.js').ThemeReference} ref */
const referenceTokenCount = (ref) => {
  const t = ref.themes[0]?.tokens;
  return t ? t.colors.length + t.lengths.length + t.fonts.length : 0;
};

/** @param {ThemeDef} t */
function describeSwitch(t) {
  const s = t.switch;
  if (s.type === 'base') return 'default styles';
  if (s.type === 'media') return `prefers-color-scheme: ${s.scheme}`;
  if (s.type === 'class') return `class "${s.name}" on <html>`;
  return `${s.attr}="${s.value}" on <html>`;
}

/** @param {string} v */
function toHex(v) {
  const c = parse(v);
  if (!c) return v;
  const hex = formatHex(c);
  return c.alpha !== undefined && c.alpha < 1 ? `${hex} @ ${Math.round(c.alpha * 100)}%` : hex;
}

/**
 * Does one computed value belong to the theme? null = the theme has no tokens for this category.
 * @param {typeof CATEGORIES[number]} cat @param {string} value @param {{ w: number, h: number }} el
 * @param {{ colorTokens: { name: string, value: string, parsed: any }[], radiusTokens: { name: string, px: number }[], sizeTokens: { name: string, px: number }[], fonts: { name: string, family: string }[] }} t
 * @returns {{ ok: boolean, display: string, nearest?: { token: string, value: string, deltaE?: number } } | null}
 */
export function matchValue(cat, value, el, t) {
  if (cat === 'color' || cat === 'background' || cat === 'border') {
    if (!t.colorTokens.length) return null;
    const c = parse(value);
    if (!c) return null;
    let best = { token: '', value: '', d: Infinity };
    for (const tok of t.colorTokens) {
      if (Math.abs((tok.parsed.alpha ?? 1) - (c.alpha ?? 1)) > 0.1) continue;
      const d = deltaE(tok.parsed, c);
      if (d < best.d) best = { token: tok.name, value: toHex(tok.value), d };
    }
    const nearest = best.token
      ? { token: best.token, value: best.value, deltaE: Math.round(best.d * 10) / 10 }
      : undefined;
    return { ok: best.d <= JND, display: toHex(value), nearest };
  }
  if (cat === 'radius') {
    if (!t.radiusTokens.length) return null;
    const px = parseFloat(value);
    if (px >= Math.min(el.w, el.h) / 2 - 1 || px >= 999) return { ok: true, display: value }; // pill or circle
    const near = nearestLength(px, t.radiusTokens);
    return {
      ok: Math.abs(near.px - px) <= 0.5,
      display: value,
      nearest: { token: near.name, value: `${near.px}px` },
    };
  }
  if (cat === 'fontSize') {
    if (!t.sizeTokens.length) return null;
    const px = parseFloat(value);
    const near = nearestLength(px, t.sizeTokens);
    return {
      ok: Math.abs(near.px - px) <= 0.5,
      display: value,
      nearest: { token: near.name, value: `${near.px}px` },
    };
  }
  if (!t.fonts.length) return null;
  const family = (value.split(',')[0] ?? '').replace(/["']/g, '').trim().toLowerCase();
  const ok = t.fonts.some((f) => f.family === family);
  return {
    ok,
    display: family,
    nearest: ok ? undefined : { token: t.fonts[0]?.name ?? '', value: t.fonts[0]?.family ?? '' },
  };
}

/** @param {number} px @param {{ name: string, px: number }[]} list */
const nearestLength = (px, list) =>
  list.reduce((a, b) => (Math.abs(b.px - px) < Math.abs(a.px - px) ? b : a));

/** @typedef {{ value: string, usesVar: boolean, origin: string, source?: string, selector?: string }} Declaration */

/**
 * Which CSS declaration produced this element's value? Chrome's own cascade answer
 * (CSS.getMatchedStylesForNode), walking up to ancestors for inherited properties.
 * @param {import('playwright').CDPSession} cdp @param {number} rootId @param {number} i
 * @param {typeof CATEGORIES[number]} cat @param {Map<string, { sourceURL: string, startLine: number, isInline: boolean }>} sheets
 * @returns {Promise<Declaration | null>}
 */
async function findDeclaration(cdp, rootId, i, cat, sheets) {
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: rootId,
    selector: `[data-aie2e-probe="${i}"]`,
  });
  if (!nodeId) return null;
  const m = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
  const names = new Set(DECLARING[cat]);
  /** @param {any} inline @param {any[]} rules @returns {Declaration | null} */
  const scan = (inline, rules) => {
    for (const p of inline?.cssProperties ?? [])
      if (names.has(p.name) && p.value && !p.disabled)
        return {
          value: `${p.name}: ${p.value}`,
          usesVar: /var\(--/.test(p.value),
          origin: 'inline',
          source: 'style attribute',
        };
    for (let k = rules.length - 1; k >= 0; k--) {
      const rule = rules[k]?.rule;
      const props = (rule?.style?.cssProperties ?? []).filter(
        (/** @type {any} */ p) => names.has(p.name) && p.value && !p.disabled,
      );
      const p = props[props.length - 1];
      if (!p) continue;
      const sheet = rule.styleSheetId ? sheets.get(rule.styleSheetId) : undefined;
      const line = rule.style?.range
        ? rule.style.range.startLine + (sheet?.startLine ?? 0) + 1
        : undefined;
      const file = !sheet
        ? undefined
        : sheet.isInline
          ? `inline <style> in ${pathOf(sheet.sourceURL)}`
          : (sheet.sourceURL.split(/[?#]/)[0] ?? '').split('/').pop() || sheet.sourceURL;
      return {
        value: `${p.name}: ${p.value}`,
        usesVar: /var\(--/.test(p.value),
        origin: rule.origin,
        source:
          rule.origin === 'user-agent'
            ? 'browser default'
            : file
              ? `${file}${line ? `:${line}` : ''}`
              : undefined,
        selector: rule.selectorList?.text,
      };
    }
    return null;
  };
  let found = scan(m.inlineStyle, m.matchedCSSRules ?? []);
  if (!found && INHERITED.has(cat)) {
    for (const inh of m.inherited ?? []) {
      found = scan(inh.inlineStyle, inh.matchedCSSRules ?? []);
      if (found) break;
    }
  }
  return found;
}

/** @param {string} url */
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Text that fails WCAG AA contrast in the current theme (axe-core, colour-contrast rule only). @param {Page} page */
async function contrastIssues(page) {
  try {
    await page.evaluate(getAxe());
    return await page.evaluate(async () => {
      // @ts-expect-error injected
      const r = await window.axe.run(document, {
        runOnly: { type: 'rule', values: ['color-contrast'] },
        resultTypes: ['violations'],
      });
      return r.violations.reduce(
        (/** @type {number} */ n, /** @type {any} */ v) => n + v.nodes.length,
        0,
      );
    });
  } catch {
    return 0;
  }
}
