import { ArrowLeft, ArrowRight, Bot, Check, ChevronDown, Wrench, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EvidenceGallery, Shot } from '../components/Evidence.jsx';
import { RESULT, testHref } from '../components/RunSummary.jsx';
import { TestDetail } from '../components/TestDetail.jsx';
import { Badge, Button } from '../components/ui.jsx';
import { MODE, fmtDuration, fmtTokens, pathOf } from '../lib/format.js';

/**
 * One test as a journey through the app: the pages the user went through (and the ones never
 * reached), the steps on each page with large screenshots, why it failed in plain words, screens
 * that look different (approve or keep), and the full developer evidence one click away.
 */

const STATUS_PILL = {
  pass: 'bg-ok-bg text-ok',
  fail: 'bg-bad-bg text-bad',
  error: 'bg-warn-bg text-warn',
};
const pct = (r) => `${Math.max(r > 0 ? 1 : 0, Math.round((r ?? 0) * 100))}%`;
/** "anthropic/claude-sonnet-5-5" -> "claude-sonnet-5-5" */
const short = (m) => String(m ?? '').replace(/^[a-z]+\//, '');
const isChanged = (v) => v.status === 'changed' || v.status === 'size';

/** "Steps 4–9" for a page's steps. */
const stepRange = (steps) =>
  !steps.length
    ? 'Final screen'
    : steps.length === 1
      ? `Step ${steps[0].n}`
      : `Steps ${steps[0].n}–${steps.at(-1).n}`;

/** A replay or agent error, in words: Playwright's timeouts mean the control was never usable. */
function stepError(reason) {
  const t = /Timeout (\d+)ms/.exec(reason ?? '');
  if (t)
    return `It never appeared or could not be used (waited ${Math.round(Number(t[1]) / 1000)} s)`;
  const m = /failed: (.+?)(;|$)/.exec(reason ?? '');
  return m ? m[1].slice(0, 140) : 'This step could not be done';
}

function Arrow({ label, tone }) {
  const color =
    tone === 'bad' ? 'var(--bad)' : tone === 'faint' ? 'var(--line-strong)' : 'var(--faint)';
  return (
    <li
      aria-hidden
      className={`flex shrink-0 flex-col items-center px-1.5 text-[11px] ${tone === 'bad' ? 'font-semibold text-bad' : 'text-muted'}`}
    >
      <span className="max-w-[110px] truncate">{label}</span>
      <svg width="44" height="12" viewBox="0 0 44 12" fill="none" stroke={color} strokeWidth="1.5">
        <line x1="0" y1="6" x2="40" y2="6" strokeDasharray={tone ? '4 3' : undefined} />
        <polyline points="35 1 41 6 35 11" />
      </svg>
    </li>
  );
}

function FlowStrip({ t, result }) {
  const reached = t.pages.filter((p) => p.status !== 'unreached').length;
  const strip = useRef(null);
  // long journeys scroll sideways: start with the page where it broke in view, not the first page
  useEffect(() => {
    const box = strip.current;
    const stuck = box?.querySelector('[data-stuck]');
    if (box && stuck)
      box.scrollLeft = Math.max(0, stuck.offsetLeft - box.clientWidth / 2 + stuck.clientWidth / 2);
  }, [t]);
  return (
    <section
      aria-labelledby="flow-h"
      className="flex flex-col gap-3.5 rounded-2xl border border-line bg-panel px-5 py-5 sm:px-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="flow-h" className="text-[15px] font-semibold">
          Where the user went
        </h2>
        <span className="text-[13px] text-muted">
          {reached} of {t.pages.length} page{t.pages.length === 1 ? '' : 's'} reached · {t.how} ·{' '}
          {fmtDuration(result.durationMs)}
        </span>
      </div>
      {t.pages.length === 0 ? (
        <p className="text-[13px] text-muted">The test stopped before it opened a page.</p>
      ) : (
        <div ref={strip} className="relative overflow-x-auto pb-1">
          <ol className="flex min-w-max items-center py-1">
            {t.pages.map((p, i) => {
              const next = t.pages[i + 1];
              const edge = next
                ? next.status === 'unreached'
                  ? {
                      label:
                        p.status === 'stuck' ? (t.failedStep?.description ?? 'never got here') : '',
                      tone: p.status === 'stuck' ? 'bad' : 'faint',
                    }
                  : { label: p.steps.at(-1)?.description ?? '', tone: undefined }
                : null;
              const cls =
                p.status === 'stuck'
                  ? 'border-2 border-bad bg-bad-bg/40'
                  : p.status === 'unreached'
                    ? 'border border-dashed border-line-strong bg-subtle/50 text-muted'
                    : 'border border-ok/30 bg-ok-bg/40';
              return (
                <li key={p.key} className="contents">
                  <a
                    data-stuck={p.status === 'stuck' ? '' : undefined}
                    href={p.status === 'unreached' ? undefined : `#page-${i}`}
                    className={`flex w-[190px] shrink-0 flex-col gap-0.5 rounded-xl px-3.5 py-3 ${cls}`}
                    onClick={(e) => {
                      if (p.status === 'unreached') return;
                      e.preventDefault();
                      document
                        .getElementById(`page-${i}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  >
                    <span
                      className={`text-[12px] font-semibold ${p.status === 'stuck' ? 'text-bad' : p.status === 'unreached' ? 'font-normal' : 'text-ok'}`}
                    >
                      {p.status === 'unreached'
                        ? 'Not reached'
                        : `${stepRange(p.steps)}${p.status === 'stuck' ? ' · stuck here' : ''}`}
                    </span>
                    <span className="truncate font-semibold text-text">{p.name}</span>
                    <span className="truncate font-mono text-[11px] text-muted">
                      {p.url ? pathOf(p.url) : p.key.replace(/^unreached:/, '')}
                    </span>
                  </a>
                  {edge && <Arrow label={edge.label} tone={edge.tone} />}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}

function StepRow({ s, error, note }) {
  const circle = s.ok ? 'bg-ok-bg text-ok' : 'bg-bad-bg text-bad';
  return (
    <li className="flex gap-2.5">
      <span
        className={`flex size-[26px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${circle}`}
      >
        {s.n}
      </span>
      <div className="min-w-0 pt-0.5">
        <div className="flex flex-wrap items-center gap-1.5 font-medium leading-snug">
          <span className="break-words">{s.description}</span>
          {s.source === 'agent' && (
            <span className="inline-flex items-center gap-0.5 rounded bg-ai/10 px-1 text-[10px] font-semibold uppercase tracking-wide text-ai">
              <Bot size={10} aria-hidden /> AI
            </span>
          )}
        </div>
        {!s.ok && <div className="text-[13px] text-bad">{error}</div>}
        {note && <div className="text-[13px] text-muted">{note}</div>}
      </div>
    </li>
  );
}

function Story({ t, result, runId, visualByStep, onCompare }) {
  const pages = t.pages.filter((p) => p.status !== 'unreached');
  const lastIdx = pages.length - 1;
  return (
    <section aria-labelledby="steps-h" className="flex min-w-0 flex-col gap-3.5">
      <h2 id="steps-h" className="text-[18px] font-semibold">
        What happened, step by step
      </h2>
      {pages.map((p, i) => {
        const stuck = p.status === 'stuck';
        const changed = [
          ...p.steps.flatMap((s) => visualByStep.get(s.index) ?? []),
          ...(i === lastIdx ? (visualByStep.get('final') ?? []) : []),
        ].filter(isChanged);
        return (
          <div key={p.key} id={`page-${t.pages.indexOf(p)}`} className="scroll-mt-6">
            <div
              className={`pb-2 pt-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] ${stuck ? 'text-bad' : 'text-muted'}`}
            >
              {p.name}
              {stuck ? ' · where it broke' : ''}
            </div>
            <article
              className={`flex flex-col gap-4 rounded-xl bg-panel p-4 md:flex-row ${stuck ? 'border-2 border-bad/30' : 'border border-line'}`}
            >
              {p.screenshot ? (
                <Shot
                  runId={runId}
                  path={p.screenshot}
                  alt={`${p.name}: the screen after ${stepRange(p.steps).toLowerCase()}`}
                  className="aspect-[16/10] w-full md:w-[56%] md:max-w-[460px]"
                />
              ) : (
                <div className="flex aspect-[16/10] w-full items-center justify-center rounded-lg border border-dashed border-line text-[13px] text-muted md:w-[56%] md:max-w-[460px]">
                  No screenshot of this page
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                {p.steps.length ? (
                  <ol className="flex flex-col gap-2.5">
                    {p.steps.map((s) => (
                      <StepRow
                        key={s.index}
                        s={s}
                        error={stepError(result.verdict.reason)}
                        note={
                          s.source === 'harness' && s.n === 1
                            ? 'Opened by the test harness'
                            : undefined
                        }
                      />
                    ))}
                  </ol>
                ) : (
                  <p className="text-[13px] text-muted">
                    The test ended here; this is the screen the judge checked.
                  </p>
                )}
                {p.observed > 0 && (
                  <p className="text-[12px] text-faint">
                    + {p.observed} look{p.observed === 1 ? '' : 's'} at the page by the AI
                    (screenshots, reading the page)
                  </p>
                )}
                {i === lastIdx && t.pageMessage && (
                  <p className="rounded-lg bg-bad-bg/60 px-3 py-2 text-[13px] text-bad">
                    The page says “{t.pageMessage}”
                  </p>
                )}
                {changed.length > 0 && (
                  <p className="mt-auto rounded-lg bg-user/10 px-3 py-2 text-[13px] text-user">
                    {changed.length === 1
                      ? 'This screen looks'
                      : `${changed.length} screens here look`}{' '}
                    different from the approved version (
                    {pct(Math.max(...changed.map((v) => v.diffRatio ?? 0)))} of pixels).{' '}
                    <button
                      type="button"
                      className="font-semibold underline-offset-2 hover:underline"
                      onClick={() => onCompare(changed[0].checkpoint)}
                    >
                      Compare
                    </button>
                  </p>
                )}
              </div>
            </article>
          </div>
        );
      })}
    </section>
  );
}

function Why({ t, result }) {
  const status = result.verdict.status;
  const hard = t.checks.filter((c) => !c.advisory);
  const advisory = t.checks.filter((c) => c.advisory);
  const failed = hard.filter((c) => !c.passed);
  const stuck = t.pages.find((p) => p.status === 'stuck');
  let sentence;
  if (status === 'pass')
    sentence = `It worked. Every check held, confirmed by the browser harness${result.agentClaim ? ', not by the AI’s own report' : ''}.`;
  else if (status === 'error')
    sentence = `The test could not run: ${result.verdict.reason.replace(/^Execution error:\s*/, '')}`;
  else if (stuck)
    sentence = [
      `The flow got stuck on “${stuck.name}”.`,
      t.pageMessage && `The page says “${t.pageMessage}”.`,
      t.failedStep && `“${t.failedStep.description}” could not be done.`,
      t.pages.some((p) => p.status === 'unreached') &&
        `${t.pages
          .filter((p) => p.status === 'unreached')
          .map((p) => `“${p.name}”`)
          .join(' and ')} never opened.`,
    ]
      .filter(Boolean)
      .join(' ');
  else if (!failed.length) sentence = result.verdict.reason;
  else sentence = `${failed.length} of ${hard.length} checks did not hold.`;
  const reasons = Object.fromEntries(t.reasons.map((r) => [r.expected, r.actual]));
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-semibold">
        {status === 'pass' ? 'Why it passed' : 'Why it failed'}
      </h2>
      <p className="text-[15px] leading-relaxed">{sentence}</p>
      <ul className="flex flex-col gap-2 text-[13px]">
        {hard.map((c, i) => (
          <li key={i} className="flex items-start gap-2">
            {c.passed ? (
              <Check size={15} className="mt-0.5 shrink-0 text-ok" aria-label="held" />
            ) : (
              <X size={15} className="mt-0.5 shrink-0 text-bad" aria-label="did not hold" />
            )}
            <span className={c.vacuous ? 'text-muted' : ''}>
              {c.label}
              {c.vacuous && (
                <span className="block text-[12px]">
                  Already true before the test acted: not counted as proof
                </span>
              )}
              {!c.passed && reasons[c.label] && (
                <span className="block text-muted">{reasons[c.label]}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {advisory.length > 0 && (
        <div className="border-t border-line pt-3">
          <div className="mb-1.5 text-[12px] font-medium text-muted">
            Advisory (never changes the result)
          </div>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {advisory.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                {c.passed ? (
                  <Check size={15} className="mt-0.5 shrink-0 text-ok" aria-label="fine" />
                ) : (
                  <span
                    className="mt-1 size-2 shrink-0 rounded-full bg-warn"
                    aria-label="needs a look"
                  />
                )}
                <span>{c.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.agentClaim && (
        <div className="rounded-lg border border-line bg-subtle/60 px-3 py-2 text-[13px]">
          <div className="flex items-center gap-1.5 font-medium">
            <Bot size={13} className="text-ai" aria-hidden /> The AI agent said
            {result.claimMismatch ? (
              <Badge tone="bad">contradicted by the evidence</Badge>
            ) : (
              <Badge tone="ok">matches the evidence</Badge>
            )}
          </div>
          <p className="mt-1 text-muted">“{result.agentClaim.message}”</p>
        </div>
      )}
    </section>
  );
}

function LooksDifferent({ results, runId, testId, review, onReview, focus }) {
  const changed = results.filter(isChanged);
  const [i, setI] = useState(() =>
    Math.max(
      0,
      changed.findIndex((v) => v.checkpoint === focus),
    ),
  );
  const [busy, setBusy] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const k = changed.findIndex((v) => v.checkpoint === focus);
    if (focus) {
      if (k >= 0) setI(k);
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!changed.length) return null;
  const v = changed[Math.min(i, changed.length - 1)];
  const decided = review[`${testId}|${v.checkpoint}`];
  const act = async (action) => {
    setBusy(action);
    try {
      await onReview?.({ testId, checkpoint: v.checkpoint, action });
    } finally {
      setBusy('');
    }
  };
  return (
    <section
      ref={ref}
      id="visual"
      className="flex scroll-mt-6 flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Looks different</h2>
        <span className="text-[12px] text-muted">
          {v.label} · {pct(v.diffRatio)} of pixels
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[12px] text-muted">
        {[
          ['Approved', v.baseline],
          ['Now', v.current],
        ].map(([cap, p]) =>
          p ? (
            <figure key={cap} className="flex flex-col gap-1">
              <Shot
                runId={runId}
                path={p}
                alt={`${v.label}: ${cap}`}
                className="aspect-[16/10] w-full"
              />
              <figcaption>{cap}</figcaption>
            </figure>
          ) : null,
        )}
      </div>
      {v.diff && (
        <figure className="flex flex-col gap-1 text-[12px] text-muted">
          <Shot
            runId={runId}
            path={v.diff}
            alt={`${v.label}: changed pixels in red`}
            className="aspect-[16/8] w-full"
          />
          <figcaption>Changed pixels in red</figcaption>
        </figure>
      )}
      {decided ? (
        <p
          className={`text-[13px] font-medium ${decided.action === 'approve' ? 'text-ok' : 'text-bad'}`}
        >
          {decided.action === 'approve'
            ? 'Approved: this is the new look from now on.'
            : 'Kept the old look: this change is treated as a bug.'}
        </p>
      ) : null}
      {onReview && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="accent"
            busy={busy === 'approve'}
            disabled={!!busy}
            onClick={() => act('approve')}
          >
            Approve new look
          </Button>
          <Button
            variant="secondary"
            busy={busy === 'reject'}
            disabled={!!busy}
            onClick={() => act('reject')}
          >
            Keep the old one
          </Button>
        </div>
      )}
      {changed.length > 1 && (
        <div className="flex items-center justify-between border-t border-line pt-2.5 text-[12px] text-muted">
          <span>
            Screen {i + 1} of {changed.length}
          </span>
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={i === 0}
              onClick={() => setI(i - 1)}
              aria-label="Previous screen"
            >
              <ArrowLeft size={13} aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={i >= changed.length - 1}
              onClick={() => setI(i + 1)}
              aria-label="Next screen"
            >
              <ArrowRight size={13} aria-hidden />
            </Button>
          </span>
        </div>
      )}
    </section>
  );
}

function HowItRan({ result, report, options }) {
  const tokens = (result.llmUsage?.inputTokens ?? 0) + (result.llmUsage?.outputTokens ?? 0);
  const mode = MODE[result.mode] ?? MODE.agent;
  const rows = [
    ['Mode', `${mode.label}${options?.suiteName ? ' of a committed suite' : ''}`],
    ['AI', tokens ? `${fmtTokens(tokens)} tokens` : 'None: no AI calls'],
    [
      'Heals',
      result.heals.length ? `${result.heals.length} (logged in Developer details)` : 'None',
    ],
    report.models &&
      (result.mode === 'agent' || result.mode === 'healed') && [
        'Agent model',
        short(report.models.agent),
      ],
    report.models &&
      result.verdict.checks.some((c) => c.expectation.kind === 'visual') && [
        'Judge model',
        short(report.models.judge),
      ],
    report.auth && ['Logged in as', report.auth.username],
    ['Time', fmtDuration(result.durationMs)],
  ].filter(Boolean);
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-[18px] text-[13px]">
      <h2 className="text-[15px] font-semibold">How it ran</h2>
      <p className="text-muted">{mode.hint}.</p>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3">
          <span className="text-muted">{k}</span>
          <span className="text-right">
            {k === 'Heals' && result.heals.length > 0 && (
              <Wrench size={12} className="mr-1 inline text-warn" aria-hidden />
            )}
            {v}
          </span>
        </div>
      ))}
    </section>
  );
}

export function TestJourney({
  runId,
  info,
  report,
  insights,
  testId,
  focusVisual,
  review,
  onReview,
  runTitle,
}) {
  const result = report.results.find((r) => r.test.id === testId);
  const t = insights.tests[testId];
  const [compare, setCompare] = useState(focusVisual ? '__first' : '');
  const [devOpen, setDevOpen] = useState(false);
  const visual = useMemo(() => result?.evidence.visual?.results ?? [], [result]);
  // replayed step N is screenshotted as checkpoint "step-N-…"; the final screen as "final"
  const visualByStep = useMemo(() => {
    const m = new Map();
    for (const v of visual) {
      const k = v.checkpoint === 'final' ? 'final' : Number(/^step-(\d+)-/.exec(v.checkpoint)?.[1]);
      if (k === 'final' || Number.isFinite(k)) m.set(k, [...(m.get(k) ?? []), v]);
    }
    return m;
  }, [visual]);
  const shots = useMemo(() => {
    if (!result) return [];
    const s = [...(result.evidence.screenshots ?? [])];
    const seen = new Set(s.map((x) => x.path));
    for (const tr of result.trace ?? [])
      if (tr.screenshot && !seen.has(tr.screenshot)) {
        seen.add(tr.screenshot);
        s.push({
          path: tr.screenshot,
          label: tr.description,
          source: 'harness',
          url: tr.url ?? '',
        });
      }
    for (const v of visual)
      for (const [kind, p] of [
        ['approved', v.baseline],
        ['now', v.current],
        ['changed pixels', v.diff],
      ])
        if (p && !seen.has(p)) {
          seen.add(p);
          s.push({ path: p, label: `visual:${v.label} · ${kind}`, source: 'harness', url: '' });
        }
    return s;
  }, [result, visual]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [testId]);

  if (!result || !t)
    return (
      <p className="text-[14px] text-muted">
        This run has no test called “{testId}”.{' '}
        <a className="text-user" href={`#/runs/${runId}`}>
          Back to the run
        </a>
      </p>
    );
  const idx = report.results.indexOf(result);
  const prev = report.results[idx - 1];
  const next = report.results[idx + 1];
  const focus = compare === '__first' ? visual.find(isChanged)?.checkpoint : compare;

  return (
    <EvidenceGallery runId={runId} shots={shots}>
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <nav aria-label="Breadcrumb" className="text-[13px] text-muted">
              <a href="#/runs" className="hover:text-text">
                Runs
              </a>{' '}
              /{' '}
              <a href={`#/runs/${runId}`} className="hover:text-text">
                {runTitle}
              </a>{' '}
              / <span className="text-text">{result.test.title}</span>
            </nav>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[28px]">
                {result.test.title}
              </h1>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${STATUS_PILL[result.verdict.status]}`}
              >
                {RESULT[result.verdict.status]?.label === 'Pass'
                  ? 'Passed'
                  : RESULT[result.verdict.status]?.label === 'Fail'
                    ? 'Failed'
                    : 'Could not run'}
              </span>
            </div>
            {result.test.goal && (
              <p className="max-w-3xl text-[13px] text-muted">Goal: {result.test.goal}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={!prev}
              onClick={() => (window.location.hash = testHref(runId, prev.test.id))}
            >
              <ArrowLeft size={14} aria-hidden /> Previous test
            </Button>
            <Button
              variant="secondary"
              disabled={!next}
              onClick={() => (window.location.hash = testHref(runId, next.test.id))}
            >
              Next test <ArrowRight size={14} aria-hidden />
            </Button>
          </div>
        </header>

        <FlowStrip t={t} result={result} />

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <Story
            t={t}
            result={result}
            runId={runId}
            visualByStep={visualByStep}
            onCompare={(cp) => setCompare(cp)}
          />
          <aside
            aria-label="Verdict and evidence"
            className="pin-xl flex min-w-0 flex-col gap-3.5 xl:pr-1"
          >
            <Why t={t} result={result} />
            <LooksDifferent
              results={visual}
              runId={runId}
              testId={testId}
              review={review}
              onReview={onReview}
              focus={focus}
            />
            <HowItRan result={result} report={report} options={info.options} />
            <section className="rounded-xl border border-line bg-panel">
              <button
                type="button"
                aria-expanded={devOpen}
                onClick={() => setDevOpen(!devOpen)}
                className="flex w-full items-center justify-between px-[18px] py-3.5 text-left text-[14px] font-semibold"
              >
                Developer details
                <ChevronDown
                  size={16}
                  className={`transition-transform ${devOpen ? 'rotate-180' : ''}`}
                  aria-hidden
                />
              </button>
              {!devOpen && (
                <p className="px-[18px] pb-3.5 text-[12px] text-muted">
                  Checks, steps and selectors, network, console, theme, quality and the agent’s
                  report.
                </p>
              )}
            </section>
          </aside>
        </div>
        {devOpen && (
          <section
            aria-label="Developer details"
            className="rounded-2xl border border-line bg-panel p-5"
          >
            <TestDetail result={result} runId={runId} review={review} onReview={onReview} />
          </section>
        )}
      </div>
    </EvidenceGallery>
  );
}
