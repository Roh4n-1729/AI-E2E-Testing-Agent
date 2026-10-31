import { ArrowDown, Bot, Check, Gavel, Loader2, MousePointerClick, X } from 'lucide-react';
import { useFollow } from '../hooks/useFollow.js';
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
        ? state.planReused
          ? `${tests.length} tests, saved plan`
          : `${tests.length} tests${fixed ? `, ${fixed} check${fixed === 1 ? '' : 's'} fixed` : ''}`
        : undefined,
    run: tests.length ? `${done} of ${tests.length} done` : undefined,
  };
  const steps = STEPS.filter(([k]) => k !== 'login' || state.phases.login);
  return (
    <ol
      aria-label="Progress"
      className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]"
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

/** Who did a step, from its source: the AI agent, or Playwright replaying / the harness. */
const ACTOR = {
  agent: { label: 'AI agent', Icon: Bot, chip: 'bg-ai/15 text-ai', dot: 'bg-ai' },
  replay: {
    label: 'Playwright',
    Icon: MousePointerClick,
    chip: 'bg-user/12 text-user',
    dot: 'bg-user',
  },
};
const actorOf = (/** @type {any} */ s) => (s?.source === 'agent' ? ACTOR.agent : ACTOR.replay);
/** Recorded steps often start with their own number ("3. Open the cart"); the UI numbers them. */
const words = (/** @type {string} */ d = '') => d.replace(/^\s*\d+[.)]\s+/, '');

/** "1:05" from milliseconds. @param {number} ms */
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** Time from the test's start to a moment. */
const since = (/** @type {string} */ start, /** @type {string | number} */ at) =>
  start && at ? new Date(at).getTime() - new Date(start).getTime() : 0;

const FRAME = {
  running: 'border-ai/60 ring-4 ring-ai/15',
  pass: 'border-ok/60 ring-4 ring-ok/15',
  fail: 'border-bad/60 ring-4 ring-bad/15',
  error: 'border-warn/60 ring-4 ring-warn/15',
  pending: 'border-line',
};
const VERDICT = {
  pass: ['Passed', 'bg-ok text-white'],
  fail: ['Failed', 'bg-bad text-white'],
  error: ['Error', 'bg-warn text-white'],
};

/**
 * The browser the test is driving, streamed live: the frame is the stage, framed in the colour of what
 * is happening (AI working, passed, failed), with the step being done right now laid over it.
 */
export function LiveStage({ test, frame, index, total, now }) {
  if (!test) return null;
  const url = test.screenshots[test.screenshots.length - 1]?.url;
  const last = test.steps.at(-1);
  const live = test.status === 'running';
  const verdict = VERDICT[test.status];
  const elapsed = test.startedAt ? since(test.startedAt, live ? now : (test.finishedAt ?? now)) : 0;
  const a = actorOf(last);
  return (
    <section aria-labelledby="live-h" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-muted">
            Test {index} of {total}
            {live && <span className="text-ai"> · running now</span>}
          </p>
          <h2 id="live-h" className="text-[20px] font-semibold leading-tight tracking-tight">
            {test.title}
          </h2>
          {test.goal && <p className="mt-1 max-w-3xl text-[13px] text-muted">{test.goal}</p>}
        </div>
        {test.startedAt && (
          <span
            className="font-mono text-[20px] tabular-nums text-muted"
            aria-label={`Time ${mmss(elapsed)}`}
          >
            {mmss(elapsed)}
          </span>
        )}
      </div>
      <div
        className={`overflow-hidden rounded-xl border-2 bg-panel shadow-pop transition-[border-color,box-shadow] ${FRAME[test.status] ?? FRAME.pending}`}
      >
        <div className="flex items-center gap-2 border-b border-line bg-subtle px-3 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-line-strong" />
            <span className="size-2.5 rounded-full bg-line-strong" />
            <span className="size-2.5 rounded-full bg-line-strong" />
          </span>
          <span className="ml-2 min-w-0 flex-1 truncate rounded-md bg-panel px-2.5 py-1 font-mono text-[11px] text-muted">
            {url ? shortUrl(url) : 'about:blank'}
          </span>
          {live && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-ai">
              <span className="pulse size-1.5 rounded-full bg-ai" aria-hidden /> Live
            </span>
          )}
        </div>
        <div className="relative aspect-[16/10] bg-canvas">
          {frame ? (
            <img
              src={frame}
              alt="Live view of the browser the test is driving"
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
          {verdict && (
            <span
              className={`pop-in absolute right-3 top-3 rounded-full px-3 py-1 text-[13px] font-semibold shadow-pop ${verdict[1]}`}
            >
              {verdict[0]}
            </span>
          )}
          {live && test.judging ? (
            <div className="absolute inset-x-3 bottom-3">
              <div className="pop-in flex items-start gap-2.5 rounded-lg border border-line-strong bg-panel/95 px-3 py-2.5 shadow-pop backdrop-blur">
                <span className="mt-px inline-flex shrink-0 items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5 text-[11px] font-semibold text-text">
                  <Gavel size={11} aria-hidden /> Judge
                </span>
                <span className="min-w-0 text-[14px] leading-snug">
                  Checking the evidence: the final page, the URL, the console, failed requests and
                  screenshots{test.judging.checks ? `, against ${test.judging.checks} checks` : ''}.
                </span>
              </div>
            </div>
          ) : (
            last && (
              <div className="absolute inset-x-3 bottom-3">
                <div
                  key={test.steps.length}
                  className={`pop-in flex items-start gap-2.5 rounded-lg border bg-panel/95 px-3 py-2.5 shadow-pop backdrop-blur ${last.ok === false ? 'border-bad/50' : 'border-line'}`}
                >
                  <span
                    className={`mt-px inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${a.chip}`}
                  >
                    <a.Icon size={11} aria-hidden /> {a.label}
                  </span>
                  <span
                    className={`min-w-0 text-[14px] leading-snug ${last.ok === false ? 'text-bad' : ''}`}
                  >
                    <span className="text-muted">Step {test.steps.length}: </span>
                    {words(last.description)}
                  </span>
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </section>
  );
}

/** Every step of the test on screen, newest last; follows new steps unless you scrolled up. */
export function StepTimeline({ test }) {
  const steps = test?.steps ?? [];
  const { ref, onScroll, unseen, jump } = useFollow(steps.length + (test?.judging ? 1 : 0));
  if (!test) return null;
  const live = test.status === 'running';
  const agent = steps.filter((s) => s.source === 'agent').length;
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3.5">
        <h2 className="text-[15px] font-semibold">Steps in this test</h2>
        <span className="text-[12px] text-muted">
          {steps.length === 0
            ? 'none yet'
            : agent === steps.length
              ? `${steps.length} by the AI agent`
              : agent === 0
                ? `${steps.length} replayed by Playwright`
                : `${agent} AI, ${steps.length - agent} Playwright`}
        </span>
      </div>
      <div className="relative">
        <ol
          ref={/** @type {any} */ (ref)}
          onScroll={onScroll}
          className="max-h-[340px] overflow-auto overscroll-contain px-2 pb-2"
        >
          {steps.map((s, i) => {
            const now = live && !test.judging && i === steps.length - 1;
            const a = actorOf(s);
            return (
              <li
                key={i}
                className={`grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2 rounded-lg px-2 py-1.5 text-[13px] ${now ? 'bg-ai/[0.08]' : ''}`}
              >
                <span className="flex h-5 items-center justify-center">
                  {s.ok === false ? (
                    <X size={14} className="text-bad" aria-label="failed" />
                  ) : now ? (
                    <Loader2 size={13} className="animate-spin text-ai" aria-label="in progress" />
                  ) : (
                    <span className={`size-2 rounded-full ${a.dot}`} title={a.label} />
                  )}
                </span>
                <span
                  className={`min-w-0 break-words ${s.ok === false ? 'text-bad' : now ? 'font-medium' : 'text-muted'}`}
                >
                  {words(s.description)}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-faint">
                  {test.startedAt && s.at ? `+${mmss(since(test.startedAt, s.at))}` : i + 1}
                </span>
              </li>
            );
          })}
          {live && test.judging && (
            <li className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2 rounded-lg bg-subtle px-2 py-1.5 text-[13px]">
              <span className="flex h-5 items-center justify-center">
                <Gavel size={13} className="text-text" aria-hidden />
              </span>
              <span className="font-medium">The judge is checking the evidence</span>
              <span className="font-mono text-[11px] tabular-nums text-faint">
                {test.startedAt && test.judging.at
                  ? `+${mmss(since(test.startedAt, test.judging.at))}`
                  : ''}
              </span>
            </li>
          )}
          {steps.length === 0 && (
            <li className="px-2 py-1.5 text-[13px] text-muted">
              {!test.goal?.trim()
                ? 'No steps: this test checks the page as it opens.'
                : live
                  ? 'Starting the browser…'
                  : 'This test has not started yet.'}
            </li>
          )}
        </ol>
        {unseen > 0 && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
            <button
              type="button"
              onClick={jump}
              className="pop-in inline-flex items-center gap-1 rounded-full bg-text px-2.5 py-1 text-[12px] font-medium text-bg shadow-pop"
            >
              <ArrowDown size={12} aria-hidden /> {unseen} new
            </button>
          </div>
        )}
      </div>
      <div className="flex gap-4 border-t border-line px-4 py-2 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-ai" aria-hidden /> AI agent
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-user" aria-hidden /> Playwright
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Gavel size={11} aria-hidden /> Judge
        </span>
      </div>
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

export function PlannedTests({ tests, selected, onSelect, planned, frames = {}, reused = false }) {
  const done = tests.filter((t) => ['pass', 'fail', 'error'].includes(t.status)).length;
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{planned ? 'Tests the AI planned' : 'Tests'}</h2>
        {tests.length > 0 && (
          <span className="text-[12px] text-muted">
            {done} of {tests.length} done
          </span>
        )}
      </div>
      {reused && (
        <p className="mb-2 rounded-lg bg-subtle px-3 py-2 text-[12px] text-muted">
          The same tests as an earlier run on this URL, so their recordings replay. For a new plan,
          switch on <span className="font-medium text-text">Plan again</span> in Run settings.
        </p>
      )}
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
                  <span className="flex min-w-0 items-center gap-2.5">
                    {t.status === 'running' && frames[t.id] && (
                      <img
                        src={frames[t.id]}
                        alt=""
                        className="h-9 w-14 shrink-0 rounded border border-ai/40 object-cover"
                      />
                    )}
                    <span
                      className={`min-w-0 truncate ${t.status === 'running' ? 'font-semibold' : ''}`}
                    >
                      {t.title}
                    </span>
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
