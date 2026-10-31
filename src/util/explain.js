/**
 * Plain-English explanations for errors that show up in real apps, so a report reader who is not a
 * developer understands what went wrong. The original text is always kept next to the explanation.
 */

/** Shorten text at a word boundary, never mid-word, with an ellipsis when something was cut. */
export function clip(text = '', max = 160) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s,.;:]+$/, '')}…`;
}

/** React's production builds replace messages with a number; these are the ones real apps hit most. */
const REACT = /** @type {Record<string, string>} */ ({
  418: 'the page rendered differently on the server and in the browser (hydration mismatch)',
  423: 'React had to throw away the server-rendered page and render it again in the browser (hydration error)',
  425: 'text rendered on the server differs from the browser (hydration mismatch; often dates, times, random values or locale formatting)',
  185: 'a component kept re-rendering itself until React stopped it (infinite update loop)',
  300: 'a component rendered fewer hooks than before (a hook inside a condition or after an early return)',
  310: 'a component rendered more hooks than before (a hook inside a condition)',
  31: 'the app tried to render a plain object as text',
  130: 'the app rendered a component that does not exist (usually a wrong import)',
});

/** @type {{ test: RegExp, explain: (m: RegExpExecArray) => string }[]} */
const RULES = [
  {
    test: /Minified React error #(\d+)/,
    explain: (m) =>
      `React error #${m[1]}: ${REACT[/** @type {string} */ (m[1])] ?? 'see react.dev/errors for this code'}`,
  },
  {
    test: /Application error: a (server|client)-side exception has occurred/i,
    explain: (m) =>
      `the page crashed with a ${m[1]}-side error (Next.js "Application error"), so the user sees an error screen`,
  },
  {
    test: /ChunkLoadError|Loading chunk [\w-]+ failed/,
    explain: () => 'part of the app’s JavaScript failed to load (often a stale deployment)',
  },
  {
    test: /Failed to load resource: the server responded with a status of (\d{3})/,
    explain: (m) => `a request failed with HTTP ${m[1]}`,
  },
  {
    test: /Hydration failed|did not match\. Server:|Text content does not match server-rendered HTML/i,
    explain: () =>
      'the page rendered differently on the server and in the browser (hydration mismatch)',
  },
  {
    test: /Cannot read propert(?:y|ies) of (undefined|null)/,
    explain: (m) => `the app’s code read a value that was ${m[1]} (a JavaScript crash)`,
  },
];

/**
 * One readable line for an error message: a plain explanation when the error is known, otherwise the
 * message itself, shortened at a word boundary.
 * @param {string} text
 */
export function explainError(text) {
  for (const r of RULES) {
    const m = r.test.exec(text);
    if (m) return r.explain(m);
  }
  return clip(text, 160);
}
