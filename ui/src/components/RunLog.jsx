import { ArrowDown, ChevronDown, Copy, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useFollow } from '../hooks/useFollow.js';

const LEVELS = {
  debug: { label: 'Debug', cls: 'text-faint' },
  info: { label: 'Info', cls: 'text-muted' },
  warn: { label: 'Warn', cls: 'text-warn', row: 'bg-warn-bg/40' },
  error: { label: 'Error', cls: 'text-bad', row: 'bg-bad-bg/50' },
};
const OPEN_KEY = 'aie2e.log.open';

/** "2026-10-31T02:31:04.120Z" -> "08:01:04" in the viewer's time. @param {string} [iso] */
const clock = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString(undefined, { hour12: false }) : '';
};
const lineText = (/** @type {any} */ l) =>
  `${clock(l.at)} ${(l.level ?? 'info').toUpperCase()} ${l.scope ? `[${l.scope}] ` : ''}${l.message}`;

/**
 * The run's log as a console: filter by level, by the test on screen, or by text; it follows new
 * lines only while you are at the bottom, and says how many arrived while you read further up.
 * @param {{ logs: any[], test?: { id: string, title: string } | null }} props
 */
export function RunLog({ logs, test }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [level, setLevel] = useState('all');
  const [onlyTest, setOnlyTest] = useState(false);
  const [q, setQ] = useState('');

  const counts = useMemo(
    () => ({
      warn: logs.filter((l) => l.level === 'warn').length,
      error: logs.filter((l) => l.level === 'error').length,
    }),
    [logs],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return logs.filter(
      (l) =>
        (level === 'all' || l.level === level) &&
        (!onlyTest || !test || String(l.scope ?? '').startsWith(test.id)) &&
        (!needle || `${l.scope ?? ''} ${l.message}`.toLowerCase().includes(needle)),
    );
  }, [logs, level, onlyTest, test, q]);
  const { ref, onScroll, unseen, jump } = useFollow(open ? shown.length : 0);

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1');
    } catch {
      /* private mode */
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown.map(lineText).join('\n'));
      toast.success(`Copied ${shown.length} ${shown.length === 1 ? 'line' : 'lines'}`);
    } catch {
      toast.error('The browser did not allow copying');
    }
  };

  return (
    <section aria-labelledby="log-h" className="rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-[14px] font-semibold"
        >
          <ChevronDown
            size={15}
            className={`text-faint transition-transform ${open ? '' : '-rotate-90'}`}
            aria-hidden
          />
          <span id="log-h">Run log</span>
          <span className="font-normal text-muted">{logs.length}</span>
        </button>
        {!open && (counts.warn > 0 || counts.error > 0) && (
          <span className="text-[12px]">
            {counts.error > 0 && <span className="text-bad">{counts.error} errors </span>}
            {counts.warn > 0 && <span className="text-warn">{counts.warn} warnings</span>}
          </span>
        )}
        {open && (
          <>
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
                  className={`rounded-md px-2 py-1 ${level === id ? 'bg-subtle font-medium text-text' : 'text-muted hover:text-text'}`}
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
            {test && (
              <label className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={onlyTest}
                  onChange={(e) => setOnlyTest(e.target.checked)}
                  className="accent-[var(--user)]"
                />
                <span className="max-w-[220px] truncate">Only “{test.title}”</span>
              </label>
            )}
            <div className="ml-auto flex items-center gap-2">
              <label className="relative">
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
                  className="h-8 w-40 rounded-lg border border-line bg-bg pl-7 pr-2 text-[12px] outline-none placeholder:text-faint focus:border-user"
                />
              </label>
              <button
                type="button"
                onClick={copy}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] text-muted hover:text-text"
              >
                <Copy size={13} aria-hidden /> Copy
              </button>
            </div>
          </>
        )}
      </div>
      {open && (
        <div className="relative border-t border-line">
          <ol
            ref={/** @type {any} */ (ref)}
            onScroll={onScroll}
            aria-live="off"
            className="h-72 min-h-32 resize-y overflow-auto overscroll-contain py-1 font-mono text-[12px] leading-[1.55]"
          >
            {shown.length === 0 && (
              <li className="px-4 py-3 font-sans text-muted">
                {logs.length ? 'No lines match.' : 'Nothing logged yet.'}
              </li>
            )}
            {shown.map((l, i) => {
              const lv = LEVELS[l.level] ?? LEVELS.info;
              return (
                <li
                  key={i}
                  className={`grid grid-cols-[64px_44px_minmax(0,1fr)] gap-x-3 px-4 py-px sm:grid-cols-[64px_44px_160px_minmax(0,1fr)] ${lv.row ?? ''}`}
                >
                  <span className="text-faint">{clock(l.at)}</span>
                  <span className={lv.cls}>{lv.label}</span>
                  <span className="hidden truncate text-faint sm:block" title={l.scope}>
                    {l.scope || 'run'}
                  </span>
                  <span className="whitespace-pre-wrap break-words text-text">{l.message}</span>
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
      )}
    </section>
  );
}
