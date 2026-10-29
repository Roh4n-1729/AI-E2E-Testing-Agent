import { parse } from 'culori';
import { describe, expect, it } from 'vitest';
import { classifyThemes } from '../src/theme/discover.js';
import { matchValue } from '../src/theme/audit.js';
import { analyseConsistency, nearDuplicate } from '../src/theme/consistency.js';

describe('theme discovery from the build CSS', () => {
  it('finds the default theme and a class-based dark theme (shadcn / Tailwind style)', () => {
    const { themes, tokenNames } = classifyThemes([
      { selector: ':root', media: '', props: { '--bg': '#fff', '--primary': '#2563eb' } },
      { selector: '.dark', media: '', props: { '--bg': '#000' } },
      { selector: '.card', media: '', props: { '--pad': '8px' } }, // component-scoped: not a theme
    ]);
    expect(themes.map((t) => [t.id, t.switch.type])).toEqual([
      ['light', 'base'],
      ['dark', 'class'],
    ]);
    expect(tokenNames).toEqual(['--bg', '--primary']);
  });

  it('handles data-theme attributes, prefers-color-scheme and @theme-style :root, :host', () => {
    const { themes } = classifyThemes([
      { selector: ':root, :host', media: '', props: { '--color-bg': '#fff' } },
      { selector: ':root', media: '(prefers-color-scheme: dark)', props: { '--color-bg': '#111' } },
      { selector: '[data-theme="ocean"]', media: '', props: { '--color-bg': '#036' } },
      { selector: 'html[data-theme=dark]', media: '', props: { '--color-bg': '#000' } },
    ]);
    const byId = Object.fromEntries(themes.map((t) => [t.id, t.switch]));
    // the explicit attribute switch wins over the media query for "dark"
    expect(byId.dark).toEqual({ type: 'attr', attr: 'data-theme', value: 'dark' });
    expect(byId.ocean).toEqual({ type: 'attr', attr: 'data-theme', value: 'ocean' });
    expect(byId.light).toEqual({ type: 'base' });
  });

  it('reports nothing for a build without theme variables (e.g. Tailwind v3 baked values)', () => {
    expect(
      classifyThemes([{ selector: '.btn', media: '', props: { '--tw-ring': '0' } }]).themes,
    ).toEqual([]);
  });
});

describe('matching a rendered value against the theme', () => {
  const t = {
    colorTokens: [{ name: '--primary', value: '#2563eb', parsed: parse('#2563eb') }],
    radiusTokens: [{ name: '--radius-sm', px: 8 }],
    sizeTokens: [],
    fonts: [{ name: '--font-sans', family: 'inter' }],
  };
  const el = { w: 200, h: 40 };

  it('accepts colours within the just-noticeable difference and rejects drift', () => {
    expect(matchValue('background', 'rgb(37, 99, 235)', el, t)?.ok).toBe(true);
    const drift = matchValue('background', 'rgb(47, 111, 228)', el, t); // #2f6fe4
    expect(drift).toMatchObject({ ok: false, display: '#2f6fe4', nearest: { token: '--primary' } });
    expect(drift?.nearest?.deltaE).toBeGreaterThan(2.3);
  });

  it('treats pill and circle radii as fine, and off-scale radii as off-theme', () => {
    expect(matchValue('radius', '20px', el, t)?.ok).toBe(true); // half the height: a pill
    expect(matchValue('radius', '7px', el, t)).toMatchObject({
      ok: false,
      nearest: { token: '--radius-sm' },
    });
  });

  it('skips categories the theme does not define, and compares the first font family', () => {
    expect(matchValue('fontSize', '15px', el, t)).toBeNull();
    expect(matchValue('fontFamily', '"Inter", sans-serif', el, t)?.ok).toBe(true);
    expect(matchValue('fontFamily', 'Arial, sans-serif', el, t)?.ok).toBe(false);
  });
});

describe('cross-page consistency', () => {
  const primary = {
    background: '#2563eb',
    color: '#ffffff',
    fontFamily: 'inter',
    fontSize: '14px',
    fontWeight: '600',
    padding: '8px 16px',
    radius: '6px',
  };

  it('flags looks that differ only slightly, not deliberate variants', () => {
    // a slightly different blue and a 1px radius: drift
    expect(nearDuplicate(primary, { ...primary, background: '#2f6fe4', radius: '7px' })).toEqual([
      { prop: 'background', a: '#2563eb', b: '#2f6fe4', deltaE: expect.any(Number) },
      { prop: 'radius', a: '6px', b: '7px' },
    ]);
    // identical, or only below the just-noticeable difference: nothing to report
    expect(nearDuplicate(primary, { ...primary })).toBeNull();
    expect(nearDuplicate(primary, { ...primary, background: '#2564eb' })).toBeNull();
    // a secondary button (very different colour), an outline button (no background), another font
    expect(
      nearDuplicate(primary, { ...primary, background: '#e5e7eb', color: '#111827' }),
    ).toBeNull();
    const outline = { ...primary, border: '#2563eb' };
    delete (/** @type {Partial<typeof outline>} */ (outline).background);
    expect(nearDuplicate(primary, outline)).toBeNull();
    expect(nearDuplicate(primary, { ...primary, fontFamily: 'georgia' })).toBeNull();
    // a large button is a size variant, not drift
    expect(nearDuplicate(primary, { ...primary, padding: '12px 24px' })).toBeNull();
  });

  it('compares the screens of a whole run, counts each screen once, and checks named components', () => {
    /** @param {string} key @param {string} url @param {any[]} inventory @param {any} [reusedFrom] */
    const state = (key, url, inventory, reusedFrom) => ({
      key,
      testId: 't',
      label: 'x',
      url,
      reusedFrom,
      audit: { tokenCount: 4, skippedSheets: [], themes: [{ id: 'light', inventory }] },
    });
    const btn = (
      /** @type {any} */ style,
      /** @type {string | undefined} */ component = undefined,
    ) => ({
      kind: 'button',
      component,
      style,
      count: 1,
      example: { selector: 'button', text: 'Buy' },
    });
    const result = (/** @type {any[]} */ states) =>
      /** @type {any} */ ({ evidence: { themeStates: states } });
    const c = analyseConsistency([
      result([state('home', 'http://app/', [btn(primary), btn(primary, 'Cta')])]),
      result([
        state('home', 'http://app/', [btn(primary)], { testId: 'a', label: 'start' }), // reused: not counted twice
        state('checkout', 'http://app/checkout', [
          btn({ ...primary, background: '#2f6fe4' }),
          btn({ ...primary, radius: '12px' }, 'Cta'),
        ]),
      ]),
    ]);
    expect(c.states).toBe(2);
    const near = c.findings.filter((f) => f.type === 'near-duplicate');
    expect(near).toHaveLength(1);
    expect(near[0]?.styles.map((s) => s.pages)).toEqual([['/'], ['/checkout']]);
    const named = c.findings.find((f) => f.type === 'component-variants');
    expect(named?.message).toBe('light: component "Cta" renders 2 different ways');
  });
});
