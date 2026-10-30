import { Bot, Check, Loader2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { pathOf, shortUrl } from '../lib/format.js';

/**
 * The live run, for anyone watching: where the run is (log in, explore, plan, test, report), the
 * browser the AI is driving with what it is doing right now, the tests it planned, what the plan
 * review fixed before anything ran, and the pages the crawl found.
 */

const STEPS = [
  ['login', 'Log in', 'once, shared by every test'],
  ['crawl', 'Explore', 'reads the app, safe links only'],
  ['plan', 'Plan', 'tests and the checks that prove them'],
  ['run', 'Test', 'a real browser per test'],
  ['report', 'Report', 'findings for anyone'],
];

export function ProgressStrip({ state }) {
  const tests = state.order.map((id) => state.tests[id]);
  const done = tests.filter((t) => ['pass', 'fail', 'error'].includes(t.status)).length;
  const fixed = state.review ? state.review.found.length : 0;
  const detail = {
    login: state.phases.login?.detail,
    crawl: state.site.length
      ? `${state.site.length} page${state.site.length === 1 ? '' : 's'} found`
      : state.phases.crawl?.detail,
    plan:
      state.phases.plan?.status === 'done'
        ? `${tests.length} tests${fixed ? ` · ${fixed} check${fixed === 1 ? '' : 's'} fixed` : ''}`
        : undefined,
    run: tests.length ? `${done} of ${tests.length} done` : undefined,
  };
  const steps = STEPS.filter(([k]) => k !== 'login' || state.phases.login);
  return (
    <ol
      aria-label="Progress"
      className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]"
    >
      {steps.map(([key, label, hint]) => {
        const p = state.phases[key];
        const s = p?.status === 'done' ? 'done' : p?.status === 'running' ? 'running' : 'next';
        return (
          <li
            key={key}
            aria-current={s === 'running' ? 'step' : undefined}
            className={`rounded-xl border px-4 py-3 ${
              s === 'done'
                ? 'border-ok/25 bg-ok-bg/50'
                : s === 'running'
                  ? 'border-ai/40 bg-ai/[0.07] shadow-sm'
                  : 'border-line bg-panel'
            }`}
          >
            <div
              className={`flex items-center gap-1 text-[12px] font-semibold ${s === 'done' ? 'text-ok' : s === 'running' ? 'text-ai' : 'text-faint'}`}
            >
              {s === 'done' ? (
                <Check size={12} strokeWidth={3} aria-hidden />
              ) : s === 'running' ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : null}
              {s === 'done' ? 'Done' : s === 'running' ? 'Running' : 'Next'}
            </div>
            <div className="text-[15px] font-semibold">{label}</div>
            <div className="truncate text-[12px] text-muted">{detail[key] ?? hint}</div>
          </li>
        );
      })}
    </ol>
  );
}

/** The browser the agent is driving, streamed live, with what it is doing now. */
export function LivePanel({ test, frame }) {
  const listRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [test?.steps.length]);
  if (!test) return null;
  const url = test.screenshots[test.screenshots.length - 1]?.url;
  const last = test.steps.at(-1);
  const live = test.status === 'running';
  return (
    <section aria-labelledby="live-h" className="flex min-w-0 flex-col gap-3">
      <div>
        <h2 id="live-h" className="text-[18px] font-semibold tracking-tight">
          {test.title}
          {live && <span className="font-medium text-ai"> · live</span>}
        </h2>
        {test.goal && <p className="mt-0.5 max-w-3xl text-[13px] text-muted">{test.goal}</p>}
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-pop">
        <div className="flex items-center gap-2 border-b border-line bg-subtle px-3 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-line-strong" />
            <span className="size-2.5 rounded-full bg-line-strong" />
            <span className="size-2.5 rounded-full bg-line-strong" />
          </span>
          <span className="ml-2 min-w-0 flex-1 truncate rounded-md bg-panel px-2.5 py-1 font-mono text-[11px] text-muted">
            {url ? shortUrl(url) : 'about:blank'}
          </span>
        </div>
        <div className="aspect-[16/10] bg-canvas">
          {frame ? (
            <img
              src={frame}
              alt="Live view of the browser the AI is driving"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-muted">
              {test.status === 'pending'
                ? 'This test has not started yet.'
                : live
                  ? 'Connecting to the browser…'
                  : 'Finished. The full evidence appears when the run completes.'}
            </div>
          )}
        </div>
      </div>
      {last && (
        <div
          className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[14px] ${live ? 'border-ai/30 bg-ai/[0.07]' : 'border-line bg-panel'}`}
        >
          <span
            className={`mt-px inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${last.source === 'replay' ? 'bg-user/10 text-user' : 'bg-ai/15 text-ai'}`}
          >
            {last.source === 'replay' ? (
              'Replay'
            ) : (
              <>
                <Bot size={11} aria-hidden /> AI
              </>
            )}{' '}
            · step {test.steps.length}
          </span>
          <span className={`min-w-0 break-words ${last.ok === false ? 'text-bad' : ''}`}>
            {last.description}
          </span>
        </div>
      )}
      {test.steps.length > 1 && (
        <ol
          ref={listRef}
          className="flex max-h-56 flex-col gap-1.5 overflow-auto px-1 text-[13px] text-muted"
        >
          {test.steps.slice(0, -1).map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              {s.ok === false ? (
                <X size={14} className="mt-0.5 shrink-0 text-bad" aria-label="failed" />
              ) : (
                <Check size={14} className="mt-0.5 shrink-0 text-ok" aria-label="done" />
              )}
              <span className="min-w-0 break-words">{s.description}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const PILL = {
  pass: ['Passed', 'text-ok'],
  fail: ['Failed', 'text-bad'],
  error: ['Error', 'text-warn'],
  running: ['Running', 'text-ai font-semibold'],
  pending: ['Queued', 'text-faint'],
};

export function PlannedTests({ tests, selected, onSelect, planned }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-2 text-[15px] font-semibold">
        {planned ? 'Tests the AI planned' : 'Tests'}
      </h2>
      {tests.length === 0 ? (
        <p className="text-[13px] text-muted">The tests appear here once the plan is ready.</p>
      ) : (
        <ul className="-mx-1.5 flex flex-col">
          {tests.map((t) => {
            const [label, cls] = PILL[t.status] ?? PILL.pending;
            const on = selected === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  aria-current={on ? 'true' : undefined}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-1.5 py-1.5 text-left text-[13px] ${on ? 'bg-subtle' : 'hover:bg-subtle/60'}`}
                >
                  <span
                    className={`min-w-0 truncate ${t.status === 'running' ? 'font-semibold' : ''}`}
                  >
                    {t.title}
                  </span>
                  <span className={`shrink-0 text-[12px] ${cls}`}>
                    {t.status === 'running' && <span className="pulse">● </span>}
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What the deterministic plan review caught before anything ran. */
export function PlanReview({ review }) {
  if (!review?.found.length) return null;
  const n = review.found.length;
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-[15px] font-semibold">
        The plan review fixed {n} check{n === 1 ? '' : 's'}
      </h2>
      <p className="mb-2.5 mt-0.5 text-[12px] text-muted">
        Before anything runs, every check is compared with what the crawl saw: a check that is
        already true, or wording the app never showed, proves nothing.
      </p>
      <ul className="flex flex-col gap-2 text-[13px]">
        {review.found.slice(0, 5).map((f, i) => (
          <li key={i} className="rounded-lg bg-subtle px-3 py-2">
            {f}
          </li>
        ))}
      </ul>
      {review.remaining.length > 0 && (
        <p className="mt-2 text-[12px] text-muted">
          {review.remaining.length} still weak after the revision: repaired automatically.
        </p>
      )}
    </section>
  );
}

export function CrawledPages({ pages }) {
  if (!pages.length) return null;
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-2 text-[15px] font-semibold">Pages the crawl found</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {pages.slice(0, 8).map((p) => (
          <li key={p.url} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">{p.title || pathOf(p.url)}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted">{pathOf(p.url)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-muted">
        {pages.length > 8 ? `+ ${pages.length - 8} more · ` : ''}logout, delete and external links
        are never followed
      </p>
    </section>
  );
}
