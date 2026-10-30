import { describe, expect, it } from 'vitest';
import { clip, explainError } from '../src/util/explain.js';

describe('error explanations for report readers', () => {
  it('explains minified React errors in plain English', () => {
    expect(
      explainError(
        'Minified React error #425; visit https://reactjs.org/docs/error-decoder.html?invariant=425 for the full message or use the non-minified dev environment',
      ),
    ).toBe(
      'React error #425: text rendered on the server differs from the browser (hydration mismatch; often dates, times, random values or locale formatting)',
    );
    expect(explainError('Minified React error #999; visit …')).toContain('React error #999');
  });

  it('explains Next.js crash screens, failed requests and JavaScript crashes', () => {
    expect(
      explainError('Application error: a server-side exception has occurred (Digest: 3277243575)'),
    ).toContain('server-side error');
    expect(
      explainError(
        'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
      ),
    ).toBe('a request failed with HTTP 500');
    expect(
      explainError("TypeError: Cannot read properties of undefined (reading 'value')"),
    ).toContain('was undefined');
  });

  it('never cuts an unknown message mid-word', () => {
    const long = 'cart-render: cannot read the quantity of an undefined line item '.repeat(5);
    const out = explainError(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(161);
    expect(long).toContain(out.slice(0, -1).split(' ').pop() + ' ');
    expect(clip('short text', 160)).toBe('short text');
  });
});
