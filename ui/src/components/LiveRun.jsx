import {
  ArrowDown,
  Bot,
  Check,
  ChevronRight,
  Gavel,
  Loader2,
  MousePointerClick,
  X,
} from 'lucide-react';
import { useFollow } from '../hooks/useFollow.js';
import { checkKind, describeExpectation, pathOf, shortUrl } from '../lib/format.js';

/**
 * The live run, for anyone watching: where the run is (log in, explore, plan, test, report), the
 * browser the AI is driving with what it is doing right now, the tests it planned, what the plan
 * review fixed before anything ran, and the pages the crawl found.
 */

const PHASES = [
  ['login', 'Log in'],
  ['crawl', 'Explore'],
  ['plan', 'Plan'],
  ['run', 'Test'],
  ['deeper', 'Explore deeper'],
  ['report', 'Report'],
];

/** Where the run is, in one line: done phases ticked, the running one spelled out with its detail. */
export function PhaseRail({ state }) {
  const tests = state.order.map((id) => state.tests[id]);
  const done = tests.filter((t) => ['pass', 'fail', 'error'].includes(t.status)).length;
  const detail = {
    login: state.phases.login?.detail,
    crawl: state.site.length
      ? `${state.site.length} page${state.site.length === 1 ? '' : 's'}`
      : state.phases.crawl?.detail,
    plan: tests.length ? `${tests.length} tests${state.planReused ? ', saved' : ''}` : undefined,
    run: tests.length ? `${done}/${tests.length}` : undefined,
    deeper: state.phases.deeper?.detail,
  };
  // log in and exploring deeper only show when the run does them
  const phases = PHASES.filter(
    ([k]) =>
      (k !== 'login' && k !== 'deeper') ||
      state.phases[k] ||
      (k === 'deeper' && state.config?.rounds > 1),
  );
  return (
    <ol aria-label="Progress" className="flex min-w-0 items-center gap-1 text-[12px]">
      {phases.map(([key, label], i) => {
        const p = state.phases[key];
        const s = p?.status === 'done' ? 'done' : p?.status === 'running' ? 'running' : 'next';
        return (
          <li key={key} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={12} className="text-faint" aria-hidden />}
            <span
              aria-current={s === 'running' ? 'step' : undefined}
              title={detail[key]}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 ${
                s === 'done'
                  ? 'text-ok'
                  : s === 'running'
                    ? 'bg-ai/10 font-semibold text-ai'
                    : 'text-faint'
              }`}
            >
              {s === 'done' ? (
                <Check size={12} strokeWidth={3} aria-hidden />
              ) : s === 'running' ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : null}
              {label}
              {detail[key] && s !== 'next' && (
                <span
                  className={`font-normal ${s === 'running' ? 'text-ai/80' : 'hidden text-muted 2xl:inline'}`}
                >
                  {detail[key]}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const STRIP = {
  pass: { bar: 'bg-ok', Icon: Check, icon: 'text-ok', label: 'passed' },
  fail: { bar: 'bg-bad', Icon: X, icon: 'text-bad', label: 'failed' },
  error: { bar: 'bg-warn', Icon: X, icon: 'text-warn', label: 'error' },
  running: { bar: 'bg-ai', Icon: null, icon: '', label: 'running' },
  pending: { bar: 'bg-line-strong', Icon: null, icon: '', label: 'queued' },
};

/** Every test as one segment: the run's progress bar and the way to switch the stage to a test. */
export function TestStrip({ tests, selected, onSelect }) {
  if (!tests.length) return null;
  return (
    <ol aria-label="Tests" className="flex gap-1.5 overflow-x-auto pb-0.5">
      {tests.map((t, i) => {
        const st = STRIP[t.status] ?? STRIP.pending;
        const on = selected === t.id;
        const newRound = (t.round ?? 1) > 1 && (tests[i - 1]?.round ?? 1) !== t.round;
        return (
          <li key={t.id} className="flex min-w-[132px] flex-1 items-stretch gap-1.5">
            {newRound && (
              <span
                className="flex shrink-0 items-center rounded-md border border-dashed border-ai/40 px-1.5 text-[11px] font-medium text-ai [writing-mode:vertical-rl]"
                title={`Round ${t.round}: tests that start on screens earlier tests reached`}
              >
                Round {t.round}
              </span>
            )}
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              aria-current={on ? 'true' : undefined}
              aria-label={`Test ${i + 1}, ${t.title}, ${st.label}`}
              className={`flex w-full min-w-0 flex-1 flex-col gap-1.5 rounded-lg border px-2.5 pb-2 pt-2 text-left transition-colors ${
                on ? 'border-text/70 bg-panel shadow-pop' : 'border-line bg-panel/60 hover:bg-panel'
              }`}
            >
              <span className={`relative h-1 overflow-hidden rounded-full ${st.bar}`}>
                {t.status === 'running' && <span className="sweep absolute inset-0" aria-hidden />}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <span className="font-mono text-faint">{i + 1}</span>
                <span
                  className={`min-w-0 flex-1 truncate ${on || t.status === 'running' ? 'font-medium text-text' : 'text-muted'}`}
                >
                  {t.title}
                </span>
                {st.Icon && <st.Icon size={12} strokeWidth={3} className={st.icon} aria-hidden />}
                {t.status === 'running' && (
                  <span className="pulse size-1.5 shrink-0 rounded-full bg-ai" aria-hidden />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Who did a step, from its source: the AI agent, or Playwright replaying / the harness. */
const ACTOR = {
  agent: { label: 'AI agent', Icon: Bot, chip: 'bg-ai/20 text-ai', dot: 'bg-ai' },
  replay: {
    label: 'Playwright',
    Icon: MousePointerClick,
    chip: 'bg-user/25 text-[#b9c0ff]',
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

const VERDICT = {
  pass: { label: 'Passed', pill: 'bg-ok text-white', stamp: 'border-ok text-ok', Icon: Check },
  fail: { label: 'Failed', pill: 'bg-bad text-white', stamp: 'border-bad text-bad', Icon: X },
  error: { label: 'Error', pill: 'bg-warn text-white', stamp: 'border-warn text-warn', Icon: X },
};

/** The colour the browser glows: the verdict once there is one, else whoever is acting now. */
function glowOf(/** @type {any} */ test) {
  if (test.status === 'pass') return 'var(--ok)';
  if (test.status === 'fail') return 'var(--bad)';
  if (test.status === 'error') return 'var(--warn)';
  if (test.status !== 'running') return 'var(--stage-muted)';
  if (test.judging) return 'var(--stage-muted)';
  const last = test.steps.at(-1);
  if (!last) return 'var(--stage-muted)';
  return last.source === 'agent' ? 'var(--ai)' : 'var(--user)';
}

/** The dark room the browser sits in; the same shell before the tests exist and while they run. */
function Room({ children, label }) {
  return (
    <section
      aria-label={label}
      className="stage-room flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl text-stage-text dark:ring-1 dark:ring-line"
    >
      {children}
    </section>
  );
}

/** Before any test runs: what the run is doing, with the pages the crawl finds appearing as it goes. */
export function StageIntro({ state }) {
  const phase =
    state.phases.login?.status === 'running'
      ? ['Logging in', 'Plain Playwright signs in once; every test reuses the session.']
      : state.phases.plan?.status === 'running'
        ? [
            'Planning the tests',
            'The AI writes user-flow tests and, for each, the checks that will prove it worked.',
          ]
        : ['Exploring the app', 'Following safe same-site links to see what pages exist.'];
  return (
    <Room label="Run starting">
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-12 text-center">
        <Loader2 size={28} className="animate-spin text-ai" aria-hidden />
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight">{phase[0]}</h2>
          <p className="mt-1 max-w-md text-[14px] text-stage-muted">{phase[1]}</p>
        </div>
        {state.site.length > 0 && (
          <ul className="flex max-w-xl flex-wrap justify-center gap-1.5">
            {state.site.slice(0, 12).map((p) => (
              <li
                key={p.url}
                className="pop-in rounded-md border border-stage-line bg-stage-2 px-2 py-1 font-mono text-[11px] text-stage-muted"
              >
                {pathOf(p.url)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Room>
  );
}

/**
 * The browser the test is driving, streamed live, in a dark room so it is the brightest thing on the
 * screen. It glows in the colour of whoever is acting (AI agent, Playwright, the judge) and then of the
 * verdict; what is happening right now is written under it, never over the page.
 */
export function LiveStage({ test, frame, index, total, now, onFollow }) {
  if (!test) return null;
  const url = test.screenshots[test.screenshots.length - 1]?.url;
  const last = test.steps.at(-1);
  const live = test.status === 'running';
  const verdict = VERDICT[test.status];
  const elapsed = test.startedAt ? since(test.startedAt, live ? now : (test.finishedAt ?? now)) : 0;
  const fresh = verdict && test.finishedAt && now - new Date(test.finishedAt).getTime() < 2600;
  const a = actorOf(last);
  return (
    <Room label="Live browser">
      <div className="flex items-start gap-4 px-5 pb-2 pt-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[12px] text-stage-muted">
            Test {index} of {total}
            {live && (
              <span className="inline-flex items-center gap-1 font-semibold text-ai">
                <span className="pulse size-1.5 rounded-full bg-ai" aria-hidden /> Live
              </span>
            )}
            {verdict && (
              <span className={`rounded-full px-2 py-px text-[11px] font-semibold ${verdict.pill}`}>
                {verdict.label}
              </span>
            )}
            {onFollow && (
              <button
                type="button"
                onClick={onFollow}
                className="rounded-full border border-stage-line px-2 py-px text-[11px] text-stage-text hover:bg-stage-2"
              >
                Back to the live test
              </button>
            )}
          </p>
          <h2 className="truncate text-[18px] font-semibold leading-snug tracking-tight">
            {test.title}
          </h2>
          {test.goal && (
            <p className="truncate text-[13px] text-stage-muted" title={test.goal}>
              {test.goal}
            </p>
          )}
          {test.startsFrom && (
            <p className="mt-0.5 truncate text-[12px] text-ai/90">
              Starts where “{test.startsFrom.title}” ended: Playwright replays those steps, then the
              AI continues
            </p>
          )}
        </div>
        {test.startedAt && (
          <span
            className="font-mono text-[26px] leading-none tabular-nums text-stage-text/90"
            aria-label={`Time ${mmss(elapsed)}`}
          >
            {mmss(elapsed)}
          </span>
        )}
      </div>

      <div className="stage-fit flex min-h-0 flex-1 items-center justify-center px-5 py-3">
        <div
          className="glow stage-window relative w-full overflow-hidden rounded-xl bg-stage-2"
          style={/** @type {any} */ ({ '--glow': glowOf(test) })}
        >
          <div className="flex h-9 items-center gap-2 border-b border-stage-line px-3">
            <span className="flex gap-1.5" aria-hidden>
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
            </span>
            <span className="ml-1 min-w-0 flex-1 truncate rounded-md bg-black/25 px-2.5 py-1 font-mono text-[11px] text-stage-muted">
              {url ? shortUrl(url) : 'about:blank'}
            </span>
          </div>
          <div className="relative aspect-[16/10] bg-white">
            {frame ? (
              <img
                src={frame}
                alt="Live view of the browser the test is driving"
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full items-center justify-center bg-stage-2 px-6 text-center text-[13px] text-stage-muted">
                {test.status === 'pending'
                  ? 'This test starts after the one running now.'
                  : live
                    ? 'Connecting to the browser…'
                    : 'Finished. Every screenshot is in the report when the run completes.'}
              </div>
            )}
            {fresh && (
              <span
                className={`stamp absolute left-1/2 top-1/2 inline-flex items-center gap-2 rounded-2xl border-[3px] bg-white/95 px-6 py-3 text-[28px] font-bold tracking-tight shadow-pop ${verdict.stamp}`}
                aria-hidden
              >
                <verdict.Icon size={28} strokeWidth={3} /> {verdict.label}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="px-5 pb-4" aria-live="polite">
        <div className="flex min-h-[44px] items-center gap-2.5 rounded-xl border border-stage-line bg-stage-2/80 px-3 py-2">
          {live && test.judging ? (
            <>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-[11px] font-semibold">
                <Gavel size={11} aria-hidden /> Judge
              </span>
              <span className="min-w-0 truncate text-[14px]">
                Checking the evidence
                {test.judging.checks ? ` against ${test.judging.checks} checks` : ''}: page, URL,
                console, requests, screenshots
              </span>
            </>
          ) : verdict ? (
            <span className="min-w-0 truncate text-[14px] text-stage-muted">
              <span className="font-medium text-stage-text">{verdict.label}</span>
              {test.result?.reason ? `: ${test.result.reason}` : ''}
            </span>
          ) : last ? (
            <>
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${a.chip}`}
              >
                <a.Icon size={11} aria-hidden /> {a.label}
              </span>
              <span
                key={test.steps.length}
                className={`pop-in min-w-0 truncate text-[14px] ${last.ok === false ? 'text-[#ff9aa1]' : ''}`}
              >
                <span className="text-stage-muted">Step {test.steps.length} </span>
                {words(last.description)}
              </span>
            </>
          ) : (
            <span className="text-[14px] text-stage-muted">
              {live ? 'Opening the start page…' : 'Waiting for its turn.'}
            </span>
          )}
        </div>
      </div>
    </Room>
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
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-4 pb-1 pt-3 text-[12px] text-muted">
        {steps.length === 0
          ? 'Chosen one at a time, from what is on the screen.'
          : agent === steps.length
            ? `${steps.length} chosen by the AI agent from what it saw`
            : agent === 0
              ? `${steps.length} replayed by Playwright, no AI`
              : `${agent} by the AI agent, ${steps.length - agent} replayed by Playwright`}
      </p>
      <div className="relative min-h-0 flex-1">
        <ol
          ref={/** @type {any} */ (ref)}
          onScroll={onScroll}
          className="h-full overflow-auto overscroll-contain px-2 pb-2"
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
    </div>
  );
}

const TAG_TONE = {
  ai: 'bg-ai/12 text-ai',
  user: 'bg-user/12 text-user',
  neutral: 'bg-subtle text-muted',
};

/**
 * What the judge will check for the test on screen. They were written before the test started and the
 * agent's steps cannot change them: the steps adapt to the page, the checks do not.
 */
export function CheckList({ test }) {
  if (!test) return null;
  const checks = test.expectations ?? [];
  const verdict = VERDICT[test.status];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain px-4 py-3">
      <p className="text-[12px] text-muted">
        Fixed before the test started. The agent decides its steps from what it sees; it cannot
        change what counts as success.
      </p>
      {checks.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">
          The checks arrive with the plan. Every test is also checked for console errors and failed
          requests.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {checks.map((e, i) => {
            const k = checkKind(e);
            return (
              <li key={i} className="rounded-lg border border-line px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 text-[13px] leading-snug">
                    {e.label ?? describeExpectation(e)}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${TAG_TONE[k.tone] ?? TAG_TONE.neutral}`}
                  >
                    {k.label}
                  </span>
                </div>
                {e.label && (
                  <p className="mt-0.5 font-mono text-[11px] text-faint">
                    {describeExpectation(e)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div
        className={`mt-3 rounded-lg px-3 py-2.5 text-[13px] ${
          verdict
            ? test.status === 'pass'
              ? 'bg-ok-bg text-ok'
              : test.status === 'fail'
                ? 'bg-bad-bg text-bad'
                : 'bg-warn-bg text-warn'
            : 'bg-subtle text-muted'
        }`}
      >
        {verdict ? (
          <>
            <span className="font-semibold">{verdict.label}</span>
            {test.result?.reason ? `: ${test.result.reason}` : ''}
          </>
        ) : test.judging ? (
          <span className="inline-flex items-center gap-1.5">
            <Gavel size={13} aria-hidden /> The judge is checking these now
          </span>
        ) : (
          'The verdict appears here when the judge has checked the evidence.'
        )}
      </div>
    </div>
  );
}

/** The plan: where the tests came from (saved or new), what the plan review fixed, what the crawl saw. */
export function PlanPanel({ state, planned, selected, onSelect }) {
  const tests = state.order.map((id) => state.tests[id]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto overscroll-contain px-4 py-3">
      <section>
        <h3 className="text-[13px] font-semibold">
          {planned
            ? `${tests.length} tests the AI planned`
            : `${tests.length} tests from the suite`}
        </h3>
        {state.planReused && (
          <p className="mt-1 rounded-lg bg-subtle px-3 py-2 text-[12px] text-muted">
            The same tests as an earlier run on this URL, so their recordings replay. For a new
            plan, switch on <span className="font-medium text-text">Plan again</span> in Run
            settings.
          </p>
        )}
        <ol className="-mx-2 mt-2 flex flex-col">
          {tests.map((t, i) => {
            const st = STRIP[t.status] ?? STRIP.pending;
            const newRound = (t.round ?? 1) > 1 && (tests[i - 1]?.round ?? 1) !== t.round;
            return (
              <li key={t.id}>
                {newRound && (
                  <p className="mx-2 mb-1 mt-3 border-t border-dashed border-ai/40 pt-2 text-[12px] font-medium text-ai">
                    Round {t.round}: these start on screens the tests above reached
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  aria-current={selected === t.id ? 'true' : undefined}
                  className={`grid w-full grid-cols-[18px_minmax(0,1fr)_14px] gap-x-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] ${selected === t.id ? 'bg-subtle' : 'hover:bg-subtle/60'}`}
                >
                  <span className="font-mono text-faint">{i + 1}</span>
                  <span className="font-medium">{t.title}</span>
                  <span className="flex h-5 items-center">
                    {st.Icon ? (
                      <st.Icon
                        size={12}
                        strokeWidth={3}
                        className={st.icon}
                        aria-label={st.label}
                      />
                    ) : t.status === 'running' ? (
                      <span className="pulse size-1.5 rounded-full bg-ai" aria-label="running" />
                    ) : null}
                  </span>
                  {t.goal && <span className="col-start-2 text-[12px] text-muted">{t.goal}</span>}
                  {t.startsFrom && (
                    <span className="col-start-2 text-[11px] text-ai/90">
                      starts where “{t.startsFrom.title}” ended
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </section>
      {state.screens.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[13px] font-semibold">New screens the tests reached</h3>
          <p className="mb-2 text-[12px] text-muted">
            Behind a click, so the crawl never saw them. Each became a starting point for the next
            round.
          </p>
          <ul className="flex flex-col gap-1 text-[12px]">
            {state.screens.map((sc) => (
              <li
                key={`${sc.round}-${sc.url}-${sc.from.testId}`}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 truncate">
                  {sc.title || pathOf(sc.url)}
                  <span className="text-muted"> via “{sc.from.title}”</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted">{pathOf(sc.url)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <PlanReview review={state.review} />
      {planned && <CrawledPages pages={state.site} />}
    </div>
  );
}

/** What the deterministic plan review caught before anything ran. */
export function PlanReview({ review }) {
  if (!review?.found.length) return null;
  const n = review.found.length;
  return (
    <section>
      <h3 className="text-[13px] font-semibold">
        The plan review fixed {n} check{n === 1 ? '' : 's'}
      </h3>
      <p className="mb-2 mt-0.5 text-[12px] text-muted">
        Before anything runs, every check is compared with what the crawl saw: a check that is
        already true, or wording the app never showed, proves nothing.
      </p>
      <ul className="flex flex-col gap-1.5 text-[12px]">
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
    <section>
      <h3 className="mb-1.5 text-[13px] font-semibold">Pages the crawl found</h3>
      <ul className="flex flex-col gap-1 text-[12px]">
        {pages.slice(0, 10).map((p) => (
          <li key={p.url} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">{p.title || pathOf(p.url)}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted">{pathOf(p.url)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[12px] text-muted">
        {pages.length > 10 ? `+ ${pages.length - 10} more. ` : ''}Logout, delete and external links
        are never followed.
      </p>
    </section>
  );
}
