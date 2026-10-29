export const fmtDuration = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};
export const fmtTokens = (n) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n ?? 0);
export const fmtBytes = (b) =>
  b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
export const fmtWhen = (iso) => {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
/** "https://app.example.com/deck/123" -> "app.example.com/deck/123" */
export const shortUrl = (u) =>
  String(u ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
/** Path + query only, for same-origin API calls. */
export const pathOf = (u) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};

export const STATUS = {
  pass: { label: 'Passed', tone: 'ok' },
  fail: { label: 'Failed', tone: 'bad' },
  error: { label: 'Error', tone: 'warn' },
  running: { label: 'Running', tone: 'ai' },
  pending: { label: 'Queued', tone: 'neutral' },
};
export const MODE = {
  agent: { label: 'Agent', tone: 'ai', hint: 'The AI agent drove the browser' },
  replay: {
    label: 'Replay',
    tone: 'user',
    hint: 'Replayed a recording with plain Playwright, no LLM',
  },
  healed: { label: 'Healed', tone: 'warn', hint: 'A replay broke and the agent took over' },
  deterministic: { label: 'Scripted', tone: 'neutral', hint: 'No AI involved' },
};

/** Human wording for an expectation, as the judge saw it. */
export function describeExpectation(e) {
  switch (e.kind) {
    case 'url':
      return `URL ${e.mode === 'regex' ? 'matches' : 'contains'} ${e.pattern}`;
    case 'text-visible':
      return `"${e.text}" is visible`;
    case 'selector-visible':
      return `${e.selector} is visible`;
    case 'visual':
      return e.question;
    case 'api-call':
      return `API ${e.method ?? 'call'} ${e.urlPattern}${e.status ? ` returns ${e.status}` : ''}${e.maxDurationMs ? ` within ${e.maxDurationMs}ms` : ''}`;
    case 'download':
      return e.filenamePattern
        ? `A ${e.filenamePattern} file is downloaded`
        : 'A file is downloaded';
    case 'text-appeared':
      return `"${e.text}" appears, even briefly`;
    case 'web-vitals':
      return 'Core Web Vitals within budget';
    case 'theme-conformance':
      return `Uses the app's own theme in every theme (≥ ${Math.round((e.minScore ?? 0.9) * 100)}% on-theme${e.allowLeaks ? '' : ', no leaks'})`;
    case 'no-a11y-violations':
      return `No ${e.minImpact ?? 'serious'} or worse accessibility issues`;
    case 'no-console-errors':
      return 'No console errors';
    case 'no-network-failures':
      return 'No failed network requests';
    default:
      return e.kind;
  }
}

/** Which family of evidence a check uses, for the small tag next to it. */
export function checkKind(e) {
  if (e.kind === 'visual') return { label: 'AI vision', tone: 'ai' };
  if (['web-vitals', 'no-a11y-violations', 'theme-conformance'].includes(e.kind))
    return { label: 'Quality', tone: 'neutral' };
  if (['no-console-errors', 'no-network-failures'].includes(e.kind))
    return { label: 'Guard', tone: 'neutral' };
  return { label: 'Hard evidence', tone: 'user' };
}
