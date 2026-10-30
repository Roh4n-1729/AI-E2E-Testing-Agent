import {
  ArrowLeft,
  Braces,
  ExternalLink,
  FileText,
  ListChecks,
  RotateCcw,
  Square,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, fileUrl } from '../api.js';
import { LivePanel, PhaseStepper } from '../components/LiveRun.jsx';
import { TestDetail } from '../components/TestDetail.jsx';
import {
  Badge,
  Button,
  Dot,
  EmptyState,
  LinkButton,
  Skeleton,
  Tooltip,
} from '../components/ui.jsx';
import { go } from '../hooks/useHashRoute.js';
import { useRunStream } from '../hooks/useRunStream.js';
import { MODE, STATUS, fmtDuration, fmtTokens, fmtWhen, shortUrl } from '../lib/format.js';
import { Consistency } from '../components/Consistency.jsx';

const FILTERS = [
  ['all', 'All', () => true],
  ['failed', 'Failed', (t) => t.status === 'fail' || t.status === 'error'],
  ['passed', 'Passed', (t) => t.status === 'pass'],
  ['healed', 'Healed', (t) => t.mode === 'healed'],
  ['mismatch', 'Claim ≠ evidence', (t) => t.claimMismatch],
];

function Elapsed({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="font-mono">{fmtDuration(Math.max(0, now - new Date(since).getTime()))}</span>
  );
}

/** Segmented pass / fail / error bar with the numbers that matter. */
function Summary({ summary, durationMs }) {
  const seg = [
    ['bg-ok', summary.passed],
    ['bg-bad', summary.failed],
    ['bg-warn', summary.errored],
  ];
  const agent = summary.inputTokens + summary.outputTokens;
  const overhead = (summary.overhead?.inputTokens ?? 0) + (summary.overhead?.outputTokens ?? 0);
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-[28px] font-semibold leading-none tracking-tight">
            {summary.passed}
            <span className="text-faint">/{summary.total}</span>
          </div>
          <div className="mt-1 text-[12px] text-muted">tests passed</div>
        </div>
        <Num label="failed" value={summary.failed} tone={summary.failed ? 'text-bad' : ''} />
        <Num label="errors" value={summary.errored} tone={summary.errored ? 'text-warn' : ''} />
        <Num label="healed" value={summary.healed} />
        {summary.visualChanges > 0 && (
          <Num label="visual changes" value={summary.visualChanges} tone="text-warn" />
        )}
        <Num
          label="claim ≠ evidence"
          value={summary.claimMismatches}
          tone={summary.claimMismatches ? 'text-bad' : ''}
        />
        <Tooltip
          content={`Browser agent ${fmtTokens(agent)} + planner and judge ${fmtTokens(overhead)}`}
        >
          <div>
            <Num label="tokens" value={fmtTokens(agent + overhead)} />
          </div>
        </Tooltip>
        {durationMs != null && <Num label="duration" value={fmtDuration(durationMs)} />}
      </div>
      <div
        className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-subtle"
        role="img"
        aria-label={`${summary.passed} passed, ${summary.failed} failed, ${summary.errored} errors`}
      >
        {seg.map(
          ([c, n], i) =>
            n > 0 && (
              <div
                key={i}
                className={c}
                style={{ width: `${(n / Math.max(1, summary.total)) * 100}%` }}
              />
            ),
        )}
      </div>
    </div>
  );
}

function Num({ label, value, tone = '' }) {
  return (
    <div>
      <div className={`font-mono text-[18px] leading-none ${tone}`}>{value}</div>
      <div className="mt-1 text-[12px] text-muted">{label}</div>
    </div>
  );
}

/** Left column: the tests, filterable. Works for live runs and finished reports alike. */
function TestList({ items, selected, onSelect }) {
  const [filter, setFilter] = useState('all');
  const fn = FILTERS.find(([k]) => k === filter)?.[2] ?? (() => true);
  const shown = items.filter(fn);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter tests">
        {FILTERS.map(([k, label, f]) => {
          const n = items.filter(f).length;
          if (k !== 'all' && n === 0) return null;
          return (
            <button
              key={k}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
              className={`rounded-md border px-2 py-1 text-[12px] ${filter === k ? 'border-text bg-text text-bg' : 'border-line bg-panel text-muted hover:text-text'}`}
            >
              {label} <span className="font-mono opacity-70">{n}</span>
            </button>
          );
        })}
      </div>
      <ul className="space-y-1">
        {shown.map((t) => {
          const st = STATUS[t.status] ?? STATUS.pending;
          const on = selected === t.id;
          return (
            <li key={t.id}>
              <button
                onClick={() => onSelect(t.id)}
                aria-current={on ? 'true' : undefined}
                className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${on ? 'border-line-strong bg-panel shadow-sm' : 'border-transparent hover:bg-panel/70'}`}
              >
                <span className="mt-1.5">
                  <Dot tone={st.tone} pulse={t.status === 'running'} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{t.title}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                    {st.label}
                    {t.mode && <span>· {MODE[t.mode]?.label ?? t.mode}</span>}
                    {t.visualChanged && <span className="text-warn">· visual change</span>}
                    {t.durationMs != null && (
                      <span className="font-mono">· {fmtDuration(t.durationMs)}</span>
                    )}
                  </span>
                </span>
                {t.claimMismatch && (
                  <span className="mt-1 text-[11px] text-bad" title="Agent claim ≠ evidence">
                    ≠
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Live({ runId, onDone }) {
  const { state, frames, connected } = useRunStream(runId);
  const [picked, setPicked] = useState(null);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (state.finished) onDone();
  }, [state.finished]); // eslint-disable-line react-hooks/exhaustive-deps
  const tests = state.order.map((id) => state.tests[id]);
  const running = tests.find((t) => t.status === 'running');
  const selected = state.tests[picked] ?? running ?? tests[0];
  const items = tests.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    mode: t.result?.mode,
    durationMs: t.result?.durationMs,
    claimMismatch: t.result?.claimMismatch,
  }));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <PhaseStepper phases={state.phases} />
        <div className="ml-auto flex items-center gap-2">
          {!connected && !state.finished && <Badge tone="warn">reconnecting…</Badge>}
          <Button
            variant="danger"
            busy={stopping}
            onClick={async () => {
              setStopping(true);
              await api.stop(runId).catch((e) => toast.error(e.message));
              toast('Stopping: open browsers are being closed');
            }}
          >
            <Square size={12} aria-hidden /> Stop run
          </Button>
        </div>
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-[13px] text-bad">
          {state.error}
        </p>
      )}
      {tests.length === 0 ? (
        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
          <div className="space-y-3">
            <p className="text-[13px] text-muted">Exploring the app and planning tests…</p>
            <Skeleton className="aspect-[16/10] w-full" />
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <TestList items={items} selected={selected?.id} onSelect={setPicked} />
          <LivePanel test={selected} frame={selected ? frames[selected.id] : null} />
        </div>
      )}
      {state.logs.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-muted">Log ({state.logs.length})</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-panel p-3 font-mono text-[11px] leading-relaxed">
            {state.logs.map((l) => `${l.scope ? `[${l.scope}] ` : ''}${l.message}`).join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

function Results({ runId, report, review, onReview }) {
  const items = useMemo(
    () =>
      report.results.map((r) => ({
        id: r.test.id,
        title: r.test.title,
        status: r.verdict.status,
        mode: r.mode,
        durationMs: r.durationMs,
        claimMismatch: r.claimMismatch,
        visualChanged: r.evidence.visual?.results?.some(
          (v) => v.status === 'changed' || v.status === 'size',
        ),
      })),
    [report],
  );
  const firstBad = items.find((t) => t.status !== 'pass');
  const [selected, setSelected] = useState((firstBad ?? items[0])?.id);
  const result = report.results.find((r) => r.test.id === selected);
  const duration = new Date(report.finishedAt) - new Date(report.startedAt);
  return (
    <div className="space-y-6">
      <Summary summary={report.summary} durationMs={duration} />
      {report.consistency?.states > 0 && <Consistency consistency={report.consistency} />}
      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-6 lg:self-start">
          <TestList items={items} selected={selected} onSelect={setSelected} />
        </div>
        <div className="min-w-0">
          {result && (
            <TestDetail
              key={result.test.id}
              result={result}
              runId={runId}
              review={review}
              onReview={onReview}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function RunView({ id }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const refetch = useCallback(() => {
    api
      .run(id)
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    setInfo(null);
    setError(null);
    refetch();
  }, [refetch]);

  if (error)
    return (
      <EmptyState
        icon={XCircle}
        title="Run not found"
        action={<LinkButton href="#/runs">Back to runs</LinkButton>}
      >
        {error}
      </EmptyState>
    );
  if (!info)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-24 w-full" />
      </div>
    );

  const target = info.report?.targetUrl ?? info.options?.url;
  const running = info.status === 'running';
  const rerun = async () => {
    try {
      // a UI suite is stored by path; the API takes its name. "Record again" and "Plan again" were
      // one-off requests for that run: running it again should replay what it recorded, not redo it.
      // eslint-disable-next-line no-unused-vars
      const { suite, suiteName, rerecord, replan, ...rest } = info.options;
      if (suite && !suiteName)
        throw new Error('This run used a suite file from the command line: run it again there.');
      const { runId } = await api.startRun(suiteName ? { ...rest, suite: suiteName } : rest);
      toast.success('Run started');
      go(`#/runs/${runId}`);
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className="space-y-6">
      <div>
        <a
          href="#/runs"
          className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-text"
        >
          <ArrowLeft size={13} aria-hidden /> Runs
        </a>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate text-[24px] font-semibold tracking-tight">
                {shortUrl(target)}
              </h1>
              <Badge
                tone={
                  running
                    ? 'ai'
                    : info.status === 'done'
                      ? info.report?.summary.failed || info.report?.summary.errored
                        ? 'bad'
                        : 'ok'
                      : 'warn'
                }
              >
                {running
                  ? 'Running'
                  : info.status === 'done'
                    ? info.report?.summary.failed || info.report?.summary.errored
                      ? 'Has failures'
                      : 'All passed'
                    : info.status}
              </Badge>
            </div>
            <p className="mt-1 text-[12px] text-muted">
              Started {fmtWhen(info.startedAt)}
              {running && (
                <>
                  {' '}
                  · running for <Elapsed since={info.startedAt} />
                </>
              )}{' '}
              · <span className="font-mono">{id}</span>
              {info.options?.suiteName && (
                <>
                  {' '}
                  · suite{' '}
                  <a
                    className="font-mono hover:text-text"
                    href={`#/suites/${info.options.suiteName}`}
                  >
                    {info.options.suiteName}
                  </a>
                </>
              )}
              {info.report?.auth && <> · logged in as {info.report.auth.username}</>}
            </p>
          </div>
          {!running && (
            <div className="flex flex-wrap gap-2">
              {info.report && (
                <>
                  <LinkButton href={fileUrl(id, 'report.html')} target="_blank" rel="noreferrer">
                    <FileText size={14} aria-hidden /> HTML report{' '}
                    <ExternalLink size={12} className="text-faint" aria-hidden />
                  </LinkButton>
                  <LinkButton href={fileUrl(id, 'report.json')} target="_blank" rel="noreferrer">
                    <Braces size={14} aria-hidden /> JSON
                  </LinkButton>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        const { name } = await api.suiteFromRun(id);
                        toast.success('Saved as a suite: edit the tests, then run them any time');
                        go(`#/suites/${name}`);
                      } catch (e) {
                        toast.error(e.message);
                      }
                    }}
                  >
                    <ListChecks size={14} aria-hidden /> Save as suite
                  </Button>
                </>
              )}
              {info.options && (
                <Button variant="primary" onClick={rerun}>
                  <RotateCcw size={14} aria-hidden /> Run again
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {running ? (
        <Live runId={id} onDone={refetch} />
      ) : info.report ? (
        <Results
          runId={id}
          report={info.report}
          review={info.review ?? {}}
          onReview={async (body) => {
            try {
              const { review } = await api.reviewVisual(id, body);
              setInfo((cur) => (cur ? { ...cur, review } : cur));
              toast.success(
                body.action === 'approve'
                  ? 'Approved: this screenshot is the new baseline'
                  : 'Rejected: the old baseline stays',
              );
            } catch (e) {
              toast.error(e.message);
            }
          }}
        />
      ) : (
        <EmptyState
          icon={info.status === 'stopped' ? Square : XCircle}
          title={info.status === 'stopped' ? 'Run stopped' : 'Run failed'}
        >
          {info.error ?? 'No report was written.'}
        </EmptyState>
      )}
    </div>
  );
}
