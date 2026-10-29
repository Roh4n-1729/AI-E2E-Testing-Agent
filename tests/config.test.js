import { describe, expect, it } from 'vitest';
import { apiKeyEnvFor, loadConfig } from '../src/config/config.js';
import { escapeHtml, mapPool, slugify } from '../src/util/misc.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({}, {});
    expect(c.headless).toBe(true);
    expect(c.concurrency).toBe(1);
    expect(c.crawl).toEqual({ maxPages: 8, maxDepth: 2 });
    expect(c.viewport).toEqual({ width: 1280, height: 800 });
    expect(c.judge.ignoreNetworkPatterns).toContain('favicon\\.ico');
  });

  it('prefers overrides over env over defaults', () => {
    const env = {
      AIE2E_MODEL: 'openai/gpt-4.1-mini',
      AIE2E_MAX_STEPS: '7',
      AIE2E_CONCURRENCY: '3',
    };
    expect(loadConfig({}, env)).toMatchObject({
      model: 'openai/gpt-4.1-mini',
      maxSteps: 7,
      concurrency: 3,
    });
    expect(
      loadConfig({ model: 'google/gemini-2.5-flash', maxSteps: undefined }, env),
    ).toMatchObject({ model: 'google/gemini-2.5-flash', maxSteps: 7 });
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({}, { AIE2E_MAX_STEPS: '-1' })).toThrow();
  });

  it('maps provider to key env var', () => {
    expect(apiKeyEnvFor('anthropic/claude-sonnet-4-5')).toBe('ANTHROPIC_API_KEY');
    expect(apiKeyEnvFor('nope/x')).toBeUndefined();
  });
});

describe('util', () => {
  it('slugifies', () => {
    expect(slugify('Click the "Sign in" button!')).toBe('click-the-sign-in-button');
    expect(slugify('!!!')).toBe('test');
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
    );
  });

  it('mapPool bounds concurrency and keeps order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
