import { AlertTriangle, CheckCircle2, ChevronRight, Eye, Sparkles, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { fileUrl } from '../api.js';
import { fmtDuration, fmtTokens } from '../lib/format.js';
import { Consistency } from './Consistency.jsx';
import { Tooltip } from './ui.jsx';

/**
 * The run, for anyone: one verdict sentence, four numbers, the problems found in plain words, and
 * the tests as a table. Everything comes from `runInsights(report)`, the same words report.html uses.
 */

export const SEVERITY = {
  high: { label: 'High', cls: 'bg-bad-bg text-bad' },
  medium: { label: 'Medium', cls: 'bg-warn-bg text-warn' },
  review: { label: 'Review', cls: 'bg-user/10 text-user' },
  low: { label: 'Low', cls: 'bg-subtle text-muted' },
};
export const CATEGORY = {
  functional: 'Functional',
  errors: 'App errors',
  visual: 'Visual',
  accessibility: 'Accessibility',
  theme: 'Theme',
  performance: 'Speed',
  agent: 'AI honesty',
  maintenance: 'Maintenance',
};
export const RESULT = {
  pass: { label: 'Pass', cls: 'bg-ok-bg text-ok', bar: 'bg-ok' },
  fail: { label: 'Fail', cls: 'bg-bad-bg text-bad', bar: 'bg-bad' },
  error: { label: 'Error', cls: 'bg-warn-bg text-warn', bar: 'bg-warn' },
};
const TONE = {
  ok: { cls: 'bg-ok-bg text-ok', Icon: CheckCircle2 },
  bad: { cls: 'bg-bad-bg text-bad', Icon: XCircle },
  warn: { cls: 'bg-warn-bg text-warn', Icon: AlertTriangle },
};

export const AI_CATEGORY = {
  'app-bug': { label: 'Looks like an app bug', cls: 'text-bad' },
  'test-problem': { label: 'Looks like a problem with the test', cls: 'text-warn' },
  environment: { label: 'Looks like the environment', cls: 'text-warn' },
  unclear: { label: 'Cause unclear', cls: 'text-muted' },
};

/** One line: the AI's reading of a failure, clearly marked as such. */
export function AiLine({ ai }) {
  const c = AI_CATEGORY[ai.category] ?? AI_CATEGORY.unclear;
  return (
    <p className="mt-1 flex gap-2 rounded-lg bg-ai/[0.07] px-3 py-2 text-[13px] leading-relaxed">
      <Sparkles size={14} className="mt-0.5 shrink-0 text-ai" aria-hidden />
      <span>
        <span className="font-semibold text-ai">AI&apos;s reading</span>
        <span className={`font-medium ${c.cls}`}> · {c.label}</span>
        {ai.confidence === 'low' && <span className="text-muted"> (low confidence)</span>}:{' '}
        {ai.cause}
      </span>
    </p>
  );
}

export const testHref = (runId, testId) => `#/runs/${runId}/tests/${encodeURIComponent(testId)}`;

function VerdictCard({ insights, report, runId }) {
  const tone = TONE[insights.tone];
  return (
    <section
      aria-label="Verdict"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-panel px-6 py-6 shadow-sm sm:px-7"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold ${tone.cls}`}
        >
          <tone.Icon size={14} strokeWidth={2.4} aria-hidden />
          {insights.headline}
        </span>
        <span className="text-[13px] text-muted">
          Judged from the page, the network and screenshots, never from the AI&apos;s own report
        </span>
      </div>
      <p className="max-w-[920px] text-[20px] font-medium leading-snug tracking-tight sm:text-[23px]">
        {insights.sentence}
      </p>
      <div
        className="flex h-2 gap-1"
        role="img"
        aria-label={`${report.summary.passed} of ${report.summary.total} tests passed`}
      >
        {report.results.map((r) => (
          <Tooltip key={r.test.id} content={`${RESULT[r.verdict.status]?.label}: ${r.test.title}`}>
            <a
              href={testHref(runId, r.test.id)}
              className={`flex-1 rounded-full transition-opacity hover:opacity-75 ${RESULT[r.verdict.status]?.bar ?? 'bg-faint'}`}
              aria-label={`${r.test.title}: ${RESULT[r.verdict.status]?.label}`}
            />
          </Tooltip>
        ))}
      </div>
    </section>
  );
}

function Kpi({ label, value, unit, tone }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-[18px] py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div
        className={`mt-0.5 text-[28px] font-semibold leading-tight tracking-tight ${tone === 'bad' ? 'text-bad' : tone === 'ok' ? 'text-ok' : ''}`}
      >
        {value}{' '}
        {unit && <span className="text-[15px] font-medium tracking-normal text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function Kpis({ insights, durationMs }) {
  const { flows, problems, review, visual, cost } = insights.kpis;
  const tokens = cost.agentTokens + cost.overheadTokens;
  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label="Flows working"
        value={flows.passed}
        unit={`of ${flows.total}`}
        tone={flows.passed === flows.total && flows.total ? 'ok' : undefined}
      />
      <Kpi
        label="Problems found"
        value={problems}
        unit={review ? `+ ${review} to review` : undefined}
        tone={problems ? 'bad' : 'ok'}
      />
      <Kpi
        label="Screens that look different"
        value={visual.tests}
        unit={
          visual.tests
            ? `test${visual.tests === 1 ? '' : 's'} · ${visual.minPct === visual.maxPct ? visual.maxPct : `${visual.minPct}–${visual.maxPct}`}% of pixels`
            : 'tests'
        }
      />
      <Kpi
        label="AI cost"
        value={fmtTokens(tokens)}
        unit={`tokens · ${
          cost.replayed === cost.total
            ? 'all replayed'
            : cost.replayed
              ? `${cost.replayed} of ${cost.total} replayed`
              : 'AI-driven'
        } · ${fmtDuration(durationMs)}`}
      />
    </section>
  );
}

/** Small names of the tests a finding was seen in, as links to each journey. */
function SeenIn({ ids, report, runId }) {
  const titles = Object.fromEntries(report.results.map((r) => [r.test.id, r.test.title]));
  const shown = ids.slice(0, 4);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
      <span className="text-muted">Seen in</span>
      {shown.map((id, i) => (
        <span key={id} className="flex items-center gap-1.5">
          {i > 0 && i === shown.length - 1 && <span className="text-muted">and</span>}
          <a href={testHref(runId, id)} className="font-medium text-user hover:underline">
            {titles[id] ?? id}
          </a>
          {i < shown.length - 2 && <span className="-ml-1.5 text-muted">,</span>}
        </span>
      ))}
      {ids.length > shown.length && (
        <span className="text-muted">and {ids.length - shown.length} more</span>
      )}
    </div>
  );
}

export function FindingCard({ f, report, runId }) {
  const sev = SEVERITY[f.severity];
  const target = testHref(runId, f.testIds[0]);
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4 sm:flex-row sm:items-start">
      {f.image ? (
        <a
          href={target}
          className="block shrink-0 overflow-hidden rounded-lg border border-line bg-canvas sm:w-[220px]"
          aria-label={`Open ${f.title}`}
        >
          <img
            src={fileUrl(runId, f.image)}
            alt=""
            loading="lazy"
            className="aspect-[16/10] w-full object-cover object-top"
          />
        </a>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold">
          <span className={`rounded-md px-2 py-0.5 ${sev.cls}`}>{sev.label}</span>
          <span className="text-muted">
            {CATEGORY[f.category] ?? f.category}
            {f.area ? ` · ${f.area}` : ''}
          </span>
        </div>
        <h3 className="text-[16px] font-semibold leading-snug">{f.title}</h3>
        <p className="text-[14px] leading-relaxed text-text/80">{f.detail}</p>
        {f.ai && <AiLine ai={f.ai} />}
        <SeenIn ids={f.testIds} report={report} runId={runId} />
        {f.category === 'visual' && (
          <div className="mt-1">
            <a
              href={`${target}?visual`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-panel px-3 text-[13px] font-medium hover:bg-subtle"
            >
              <Eye size={14} aria-hidden /> Compare screenshots
            </a>
          </div>
        )}
      </div>
    </article>
  );
}

function Findings({ insights, report, runId }) {
  const [cat, setCat] = useState('all');
  const cats = useMemo(() => {
    const n = {};
    for (const f of insights.findings) n[f.category] = (n[f.category] ?? 0) + 1;
    return n;
  }, [insights]);
  const shown = insights.findings.filter((f) => cat === 'all' || f.category === cat);
  if (!insights.findings.length)
    return (
      <section className="rounded-xl border border-ok/25 bg-ok-bg/50 px-5 py-4 text-[14px]">
        <span className="font-semibold text-ok">Nothing is wrong.</span>{' '}
        <span className="text-muted">
          Every planned check held, with evidence collected by the harness.
        </span>
      </section>
    );
  const chip = (key, label, count) => (
    <button
      key={key}
      type="button"
      onClick={() => setCat(key)}
      aria-pressed={cat === key}
      className={`h-8 rounded-full border px-3 text-[13px] transition-colors ${cat === key ? 'border-text bg-text text-bg' : 'border-line-strong bg-panel hover:bg-subtle'}`}
    >
      {label} <span className="opacity-70">{count}</span>
    </button>
  );
  return (
    <section aria-labelledby="findings-h" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="findings-h" className="text-[18px] font-semibold">
          What is wrong
        </h2>
        {Object.keys(cats).length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter problems">
            {chip('all', 'All', insights.findings.length)}
            {Object.entries(cats).map(([k, n]) => chip(k, CATEGORY[k] ?? k, n))}
          </div>
        )}
      </div>
      {shown.map((f) => (
        <FindingCard key={f.id} f={f} report={report} runId={runId} />
      ))}
    </section>
  );
}

function TestsTable({ insights, report, runId }) {
  const order = { error: 0, fail: 1, pass: 2 };
  const rows = [...report.results].sort(
    (a, b) => (order[a.verdict.status] ?? 3) - (order[b.verdict.status] ?? 3),
  );
  return (
    <section aria-labelledby="tests-h" className="flex flex-col gap-3">
      <h2 id="tests-h" className="text-[18px] font-semibold">
        Tests
      </h2>
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full min-w-[760px] border-collapse text-[14px]">
          <thead>
            <tr className="text-left text-[12px] text-muted">
              {['Result', 'Test', 'What happened', 'How it ran', 'Time'].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className={`border-b border-line px-4 py-3 font-medium ${h === 'Time' ? 'text-right' : ''}`}
                >
                  {h}
                </th>
              ))}
              <th className="w-8 border-b border-line" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const t = insights.tests[r.test.id];
              const res = RESULT[r.verdict.status] ?? RESULT.error;
              return (
                <tr
                  key={r.test.id}
                  className="group cursor-pointer border-b border-line/70 last:border-0 hover:bg-subtle/60"
                  onClick={() => (window.location.hash = testHref(runId, r.test.id))}
                >
                  <td className="px-4 py-3">
                    <span className={`rounded-md px-2 py-0.5 text-[12px] font-semibold ${res.cls}`}>
                      {res.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={testHref(runId, r.test.id)}
                      className="font-medium text-text hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.test.title}
                    </a>
                  </td>
                  <td className="max-w-[420px] px-4 py-3 text-text/80">{t?.outcome}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">
                    {t?.how}
                    {r.heals.length > 0 && <span className="text-warn"> · healed</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-[13px] text-muted">
                    {fmtDuration(r.durationMs)}
                  </td>
                  <td className="pr-3 text-faint group-hover:text-text">
                    <ChevronRight size={16} aria-hidden />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function RunSummary({ runId, report, insights }) {
  const duration = new Date(report.finishedAt) - new Date(report.startedAt);
  return (
    <div className="flex flex-col gap-6">
      <VerdictCard insights={insights} report={report} runId={runId} />
      <Kpis insights={insights} durationMs={duration} />
      <Findings insights={insights} report={report} runId={runId} />
      <TestsTable insights={insights} report={report} runId={runId} />
      {report.consistency?.findings?.length > 0 && <Consistency consistency={report.consistency} />}
    </div>
  );
}
