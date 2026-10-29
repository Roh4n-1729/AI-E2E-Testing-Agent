/**
 * Theme discovery from the PRODUCTION BUILD: no configuration, no Figma, no reference site.
 * The stylesheets the page actually loaded say which themes exist and what their tokens are:
 * CSS custom properties defined on `:root`, `.dark`, `[data-theme="…"]`, or inside
 * `@media (prefers-color-scheme: dark)`. Tailwind v4 `@theme`, shadcn, Radix Themes, MUI CSS
 * variables and hand-written variables all end up there.
 *
 * @import { Page } from 'playwright'
 */

/**
 * @typedef {{ type: 'base' } | { type: 'media', scheme: 'dark' | 'light' } | { type: 'class', name: string } | { type: 'attr', attr: string, value: string }} ThemeSwitch
 * @typedef {{ id: string, switch: ThemeSwitch, overrides: Record<string, string> }} ThemeDef
 * @typedef {{ themes: ThemeDef[], tokenNames: string[], skippedSheets: string[] }} ThemeDiscovery
 */

/** Runs in the page: every CSS custom property declaration with its selector and media condition. */
function readCustomProperties() {
  /** @type {{ selector: string, media: string, props: Record<string, string> }[]} */
  const rules = [];
  /** @type {string[]} */
  const skipped = [];
  /** @param {CSSRuleList} list @param {string} media */
  const visit = (list, media) => {
    for (const r of Array.from(list)) {
      if (r instanceof CSSStyleRule) {
        /** @type {Record<string, string>} */
        const props = {};
        for (let i = 0; i < r.style.length; i++) {
          const n = r.style[i];
          if (n && n.startsWith('--')) props[n] = r.style.getPropertyValue(n).trim();
        }
        if (Object.keys(props).length) rules.push({ selector: r.selectorText, media, props });
        if (r.cssRules && r.cssRules.length) visit(r.cssRules, media); // CSS nesting
      } else if (r instanceof CSSMediaRule) {
        visit(r.cssRules, [media, r.conditionText].filter(Boolean).join(' and '));
      } else if (/** @type {any} */ (r).cssRules) {
        visit(/** @type {any} */ (r).cssRules, media); // @layer, @supports, @container
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules, '');
    } catch {
      skipped.push(sheet.href ?? 'inline'); // cross-origin sheet without CORS: unreadable
    }
  }
  return { rules, skipped };
}

const BASE = /^(?::root|html|:host|body)$/;
const CLASS = /^(?::root|html|body)?\.([A-Za-z][\w-]*)$/;
const ATTR = /^(?::root|html|body)?\[(data-[\w-]+)\s*~?=\s*["']?([\w-]+)["']?\]$/;
const DARK = /prefers-color-scheme:\s*dark/;
const LIGHT = /prefers-color-scheme:\s*light/;

/**
 * Turn raw custom-property rules into a theme list. Pure, so it is unit-tested without a browser.
 * @param {{ selector: string, media: string, props: Record<string, string> }[]} rules
 * @returns {Omit<ThemeDiscovery, 'skippedSheets'>}
 */
export function classifyThemes(rules) {
  /** @type {Map<string, ThemeDef>} */
  const themes = new Map();
  /** @type {Set<string>} */
  const names = new Set();
  const add = (
    /** @type {string} */ id,
    /** @type {ThemeSwitch} */ sw,
    /** @type {Record<string, string>} */ props,
  ) => {
    const t = themes.get(id) ?? { id, switch: sw, overrides: {} };
    // an explicit class/attribute switch is preferred over the media query (it is what the app toggles)
    if (t.switch.type === 'media' && sw.type !== 'media' && sw.type !== 'base') t.switch = sw;
    Object.assign(t.overrides, props);
    themes.set(id, t);
  };
  for (const r of rules) {
    // only rules that also apply on screen
    if (r.media && !/screen|prefers-color-scheme/.test(r.media) && !/^\s*$/.test(r.media)) continue;
    for (const raw of r.selector.split(',')) {
      const sel = raw.trim();
      let m;
      if (BASE.test(sel)) {
        if (DARK.test(r.media)) add('dark', { type: 'media', scheme: 'dark' }, r.props);
        else if (LIGHT.test(r.media)) add('light', { type: 'media', scheme: 'light' }, r.props);
        else add('base', { type: 'base' }, r.props);
      } else if ((m = CLASS.exec(sel))) {
        add(
          /** @type {string} */ (m[1]),
          { type: 'class', name: /** @type {string} */ (m[1]) },
          r.props,
        );
      } else if ((m = ATTR.exec(sel))) {
        add(
          /** @type {string} */ (m[2]),
          { type: 'attr', attr: /** @type {string} */ (m[1]), value: /** @type {string} */ (m[2]) },
          r.props,
        );
      } else {
        continue; // component-scoped variables (.card { --pad: … }) are not themes
      }
      for (const n of Object.keys(r.props)) names.add(n);
    }
  }
  const base = themes.get('base');
  themes.delete('base');
  // A class or attribute rule is a THEME only when it re-defines variables the base defines (.dark
  // overriding --bg), or, with no base at all, when its name says so ([data-theme=…], .dark). Otherwise
  // it is a component-scoped variable (.card { --pad: 8px }).
  const baseNames = new Set(Object.keys(base?.overrides ?? {}));
  const looksLikeTheme = (/** @type {ThemeDef} */ t) =>
    t.switch.type === 'media' ||
    Object.keys(t.overrides).some((n) => baseNames.has(n)) ||
    (!baseNames.size &&
      ((t.switch.type === 'attr' && /theme|mode|scheme|color/i.test(t.switch.attr)) ||
        (t.switch.type === 'class' && /dark|light|theme/i.test(t.switch.name))));
  for (const [id, t] of themes) if (!looksLikeTheme(t)) themes.delete(id);
  names.clear();
  for (const n of baseNames) names.add(n);
  for (const t of themes.values()) for (const n of Object.keys(t.overrides)) names.add(n);
  const list = [...themes.values()].filter((t) => Object.keys(t.overrides).length > 0);
  // the base theme is "light" when the app also ships a dark one, unless "light" exists explicitly
  if (base && !themes.has('light'))
    list.unshift({
      id: list.length ? 'light' : 'default',
      switch: { type: 'base' },
      overrides: {},
    });
  else if (base && themes.has('light')) {
    const light = /** @type {ThemeDef} */ (themes.get('light'));
    light.overrides = { ...base.overrides, ...light.overrides };
  }
  return { themes: list, tokenNames: [...names].sort() };
}

/** @param {Page} page @returns {Promise<ThemeDiscovery>} */
export async function discoverThemes(page) {
  const { rules, skipped } = await page.evaluate(readCustomProperties);
  return { ...classifyThemes(rules), skippedSheets: skipped };
}

/**
 * Snapshot of how the page is themed right now, to restore it after the audit.
 * @param {Page} page
 */
export async function themeState(page) {
  return page.evaluate(() => ({
    html: document.documentElement.getAttribute('class'),
    attrs: Object.fromEntries(
      Array.from(document.documentElement.attributes)
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => [a.name, a.value]),
    ),
  }));
}

/**
 * Switch the page to a theme the way the app does it. Transitions are frozen so the audit reads final
 * colours, not a frame of a fade.
 * @param {Page} page @param {ThemeDef} theme @param {ThemeDef[]} all
 */
export async function applyTheme(page, theme, all) {
  const classes = all.flatMap((t) => (t.switch.type === 'class' ? [t.switch.name] : []));
  const attrs = [...new Set(all.flatMap((t) => (t.switch.type === 'attr' ? [t.switch.attr] : [])))];
  const sw = theme.switch;
  await page.emulateMedia({
    colorScheme: sw.type === 'media' ? sw.scheme : theme.id === 'dark' ? 'dark' : 'light',
  });
  await page.evaluate(
    ({ sw, classes, attrs }) => {
      const root = document.documentElement;
      if (!document.getElementById('__aie2e_freeze')) {
        const s = document.createElement('style');
        s.id = '__aie2e_freeze';
        s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
        document.head.appendChild(s);
      }
      for (const c of classes) root.classList.remove(c);
      for (const a of attrs) root.removeAttribute(a);
      if (sw.type === 'class') root.classList.add(sw.name);
      if (sw.type === 'attr') root.setAttribute(sw.attr, sw.value);
    },
    { sw, classes, attrs },
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/**
 * Put the page back exactly as the app had it.
 * @param {Page} page @param {Awaited<ReturnType<typeof themeState>>} state
 */
export async function restoreTheme(page, state) {
  await page.emulateMedia({ colorScheme: null });
  await page.evaluate((st) => {
    const root = document.documentElement;
    if (st.html === null) root.removeAttribute('class');
    else root.setAttribute('class', st.html);
    for (const a of Array.from(root.attributes))
      if (a.name.startsWith('data-') && !(a.name in st.attrs)) root.removeAttribute(a.name);
    for (const [k, v] of Object.entries(st.attrs)) root.setAttribute(k, v);
    document.getElementById('__aie2e_freeze')?.remove();
  }, state);
}
