import { parse } from 'culori';
import { describe, expect, it } from 'vitest';
import { classifyThemes } from '../src/theme/discover.js';
import { matchValue } from '../src/theme/audit.js';

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
