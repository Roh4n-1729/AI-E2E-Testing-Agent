import { ArrowDown, Copy, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useFollow } from '../hooks/useFollow.js';

const LEVELS = {
  debug: { label: 'Debug', edge: 'border-transparent', text: 'text-faint' },
  info: { label: 'Info', edge: 'border-transparent', text: 'text-text' },
  warn: { label: 'Warning', edge: 'border-warn', text: 'text-warn', row: 'bg-warn-bg/40' },
  error: { label: 'Error', edge: 'border-bad', text: 'text-bad', row: 'bg-bad-bg/50' },
};
/** "add-to-cart:agent" -> "add-to-cart": the full scope is in the tooltip; the line only needs which test. */
const shortScope = (/** @type {string} */ s) => s.split(':')[0];

/** "2026-10-31T02:31:04.120Z" -> "08:01:04" in the viewer's time. @param {string} [iso] */
const clock = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString(undefined, { hour12: false }) : '';
};
const lineText = (/** @type {any} */ l) =>
  `${clock(l.at)} ${(l.level ?? 'info').toUpperCase()} ${l.scope ? `[${l.scope}] ` : ''}${l.message}`;

/**
 * The run's log as a console, sized to the panel it sits in: filter by level, by the test on screen,
 * or by text. It follows new lines only while you are at the bottom, and says how many arrived while
 * you read further up.
 * @param {{ logs: any[], test?: { id: string, title: string } | null }} props
 */
export function RunLog({ logs, test }) {
  const [level, setLevel] = useState('all');
  const [onlyTest, setOnlyTest] = useState(false);
  const [q, setQ] = useState('');

  const counts = useMemo(() => logCounts(logs), [logs]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return logs.filter(
      (l) =>
        (level === 'all' || l.level === level) &&
        (!onlyTest || !test || String(l.scope ?? '').startsWith(test.id)) &&
        (!needle || `${l.scope ?? ''} ${l.message}`.toLowerCase().includes(needle)),
    );
  }, [logs, level, onlyTest, test, q]);
  const { ref, onScroll, unseen, jump } = useFollow(shown.length);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown.map(lineText).join('\n'));
      toast.success(`Copied ${shown.length} ${shown.length === 1 ? 'line' : 'lines'}`);
    } catch {
      toast.error('The browser did not allow copying');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div
            role="radiogroup"
            aria-label="Show"
            className="flex rounded-lg border border-line p-0.5 text-[12px]"
          >
            {[
              ['all', 'All', logs.length],
              ['warn', 'Warnings', counts.warn],
              ['error', 'Errors', counts.error],
            ].map(([id, label, n]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={level === id}
                onClick={() => setLevel(String(id))}
                className={`rounded-md px-2 py-0.5 ${level === id ? 'bg-subtle font-medium text-text' : 'text-muted hover:text-text'}`}
              >
                {label}{' '}
                <span
                  className={
                    id === 'error' && Number(n) > 0
                      ? 'text-bad'
                      : id === 'warn' && Number(n) > 0
                        ? 'text-warn'
                        : 'text-faint'
                  }
                >
                  {n}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={copy}
            aria-label="Copy the lines shown"
            title="Copy the lines shown"
            className="ml-auto inline-flex size-7 items-center justify-center rounded-lg border border-line text-muted hover:text-text"
          >
            <Copy size={13} aria-hidden />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search the log</span>
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
              aria-hidden
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              className="h-7 w-full rounded-lg border border-line bg-bg pl-7 pr-2 text-[12px] outline-none placeholder:text-faint focus:border-user"
            />
          </label>
          {test && (
            <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={onlyTest}
                onChange={(e) => setOnlyTest(e.target.checked)}
                className="accent-[var(--user)]"
              />
              This test only
            </label>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <ol
          ref={/** @type {any} */ (ref)}
          onScroll={onScroll}
          aria-live="off"
          className="h-full overflow-auto overscroll-contain py-1 font-mono text-[11.5px] leading-[1.55]"
        >
          {shown.length === 0 && (
            <li className="px-4 py-3 font-sans text-[13px] text-muted">
              {logs.length ? 'No lines match.' : 'Nothing logged yet.'}
            </li>
          )}
          {shown.map((l, i) => {
            const lv = LEVELS[l.level] ?? LEVELS.info;
            return (
              <li
                key={i}
                title={`${lv.label}${l.scope ? ` · ${l.scope}` : ''}`}
                className={`grid grid-cols-[58px_minmax(0,1fr)] gap-x-2 border-l-2 py-px pl-2.5 pr-3 ${lv.edge} ${lv.row ?? ''}`}
              >
                <span className="text-faint">{clock(l.at)}</span>
                <span className={`whitespace-pre-wrap break-words ${lv.text}`}>
                  {l.scope && <span className="text-faint">{shortScope(l.scope)} </span>}
                  {l.message}
                </span>
              </li>
            );
          })}
        </ol>
        {unseen > 0 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
            <button
              type="button"
              onClick={jump}
              className="pop-in inline-flex items-center gap-1.5 rounded-full bg-text px-3 py-1.5 text-[12px] font-medium text-bg shadow-pop"
            >
              <ArrowDown size={13} aria-hidden /> {unseen} new {unseen === 1 ? 'line' : 'lines'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Warning and error counts, for the filter and the Log tab's badge. @param {any[]} logs */
export function logCounts(logs) {
  let warn = 0;
  let error = 0;
  for (const l of logs) {
    if (l.level === 'warn') warn++;
    else if (l.level === 'error') error++;
  }
  return { warn, error };
}
