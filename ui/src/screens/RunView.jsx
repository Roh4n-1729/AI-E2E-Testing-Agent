import {
  ArrowLeft,
  Braces,
  ExternalLink,
  FileText,
  ListChecks,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Square,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DEMO, api, fileUrl } from '../api.js';
import {
  CheckList,
  LiveStage,
  PhaseRail,
  PlanPanel,
  StageIntro,
  StepTimeline,
  TestStrip,
} from '../components/LiveRun.jsx';
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
import { RunSummary } from '../components/RunSummary.jsx';
import { runInsights } from '../../../src/reporter/insights.js';
import { TestJourney } from './TestJourney.jsx';
import { RunLog, logCounts } from '../components/RunLog.jsx';

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

const DOCK = [
  ['steps', 'Steps'],
  ['checks', 'Checks'],
  ['log', 'Log'],
  ['plan', 'Plan'],
];
const DOCK_KEY = 'aie2e.live.tab';

/**
 * The live run as a cockpit: one screen tall, nothing to scroll. The browser is the stage; the steps,
 * the checks the judge will apply, the log and the plan are tabs beside it, so reading the log never
 * moves the browser out of view. Keys: 1 to 4 switch tabs, F hides the panel.
 */
function Live({ runId, onDone, fromSuite, app, who, target, startedAt }) {
  const { state, frames, connected } = useRunStream(runId);
  const [picked, setPicked] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [tab, setTabState] = useState(() => {
    try {
      return localStorage.getItem(DOCK_KEY) || 'steps';
    } catch {
      return 'steps';
    }
  });
  const [focus, setFocus] = useState(false);
  const setTab = (t) => {
    setTabState(t);
    setFocus(false);
    try {
      localStorage.setItem(DOCK_KEY, t);
    } catch {
      /* private mode */
    }
  };
  useEffect(() => {
    if (state.finished) onDone();
  }, [state.finished]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      )
        return;
      const i = Number(e.key) - 1;
      if (DOCK[i]) setTab(DOCK[i][0]);
      else if (e.key === 'f' || e.key === 'F') setFocus((f) => !f);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tests = state.order.map((id) => state.tests[id]);
  const running = tests.find((t) => t.status === 'running');
  const now = useNow(!state.finished);
  // A test that has just finished stays on stage until the next one has a picture, so its verdict is
  // seen instead of a blank "connecting" browser.
  const justDone = tests
    .filter((t) => t.finishedAt && now - new Date(t.finishedAt).getTime() < 2600)
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0];
  const held = justDone && (!running || !frames[running.id]) ? justDone : null;
  const selected =
    state.tests[picked] ??
    held ??
    running ??
    tests.findLast((t) => t.status !== 'pending') ??
    tests[0];
  const counts = useMemo(() => logCounts(state.logs), [state.logs]);
  const badge = {
    steps: selected?.steps.length || null,
    checks: selected?.expectations?.length || null,
    log: counts.error || counts.warn || null,
    plan: tests.length || null,
  };
  const stop = async () => {
    setStopping(true);
    await api.stop(runId).catch((e) => toast.error(e.message));
    toast('Stopping: open browsers are being closed');
  };

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100dvh-4rem)] lg:min-h-[620px]">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:flex-nowrap">
        <div className="flex min-w-0 items-center gap-2.5">
          <a
            href="#/runs"
            aria-label="Back to runs"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line text-muted hover:bg-subtle hover:text-text"
          >
            <ArrowLeft size={15} aria-hidden />
          </a>
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-semibold leading-tight tracking-tight">
              {app}
              {who && <span className="font-normal text-muted">, as {who}</span>}
            </h1>
            <p className="truncate font-mono text-[11px] text-faint">{shortUrl(target)}</p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ai/10 px-2.5 py-1 text-[12px] font-semibold text-ai">
          <span className="pulse size-2 rounded-full bg-ai" aria-hidden />
          {fromSuite ? 'Testing' : 'AI is testing'}
          {startedAt && (
            <span className="font-normal text-ai/80">
              <Elapsed since={startedAt} />
            </span>
          )}
        </span>
        <div className="min-w-0 overflow-x-auto lg:flex-1">
          <PhaseRail state={state} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {state.config && (
            <span className="hidden text-[12px] text-muted 2xl:inline">
              {state.config.preset ? `${state.config.preset} · ` : ''}
              {String(state.config.model).replace(/^[a-z]+\//, '')}
            </span>
          )}
          {!connected && !state.finished && <Badge tone="warn">reconnecting…</Badge>}
          {focus && (
            <Button variant="secondary" onClick={() => setFocus(false)}>
              <PanelRightOpen size={14} aria-hidden /> Steps and log
              {counts.error > 0 && (
                <span className="rounded-full bg-bad px-1.5 text-[11px] text-white">
                  {counts.error}
                </span>
              )}
            </Button>
          )}
          <Button variant="danger" busy={stopping} onClick={stop}>
            <Square size={12} aria-hidden /> Stop run
          </Button>
        </div>
      </header>

      {state.error && (
        <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-[13px] text-bad">
          {state.error}
        </p>
      )}
      <TestStrip tests={tests} selected={selected?.id} onSelect={setPicked} />

      <div
        className={`grid min-h-0 flex-1 gap-3 ${focus ? '' : 'lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]'}`}
      >
        {selected ? (
          <LiveStage
            test={selected}
            frame={frames[selected.id]}
            index={tests.indexOf(selected) + 1}
            total={tests.length}
            now={now}
            onFollow={
              picked && running && selected.id !== running.id ? () => setPicked(null) : undefined
            }
          />
        ) : (
          <StageIntro state={state} />
        )}
        {!focus && (
          <aside
            aria-label="Run details"
            className="flex h-[520px] min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel lg:h-auto"
          >
            <div
              role="tablist"
              aria-label="Details"
              className="flex items-center border-b border-line px-1.5"
            >
              {DOCK.map(([id, label], i) => (
                <button
                  key={id}
                  role="tab"
                  type="button"
                  id={`dock-${id}`}
                  aria-selected={tab === id}
                  aria-controls="dock-panel"
                  title={`${label} (${i + 1})`}
                  onClick={() => setTab(id)}
                  className={`relative inline-flex items-center gap-1.5 px-2.5 py-2.5 text-[13px] ${
                    tab === id ? 'font-semibold text-text' : 'text-muted hover:text-text'
                  }`}
                >
                  {label}
                  {badge[id] != null && (
                    <span
                      className={`rounded-full px-1.5 text-[11px] tabular-nums ${
                        id === 'log' && counts.error
                          ? 'bg-bad-bg font-semibold text-bad'
                          : id === 'log'
                            ? 'bg-warn-bg font-semibold text-warn'
                            : 'bg-subtle text-muted'
                      }`}
                    >
                      {badge[id]}
                    </span>
                  )}
                  {tab === id && (
                    <span
                      className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-text"
                      aria-hidden
                    />
                  )}
                </button>
              ))}
              <Tooltip content="Hide this panel (F)">
                <button
                  type="button"
                  onClick={() => setFocus(true)}
                  aria-label="Hide the panel"
                  className="ml-auto hidden size-7 items-center justify-center rounded-md text-faint hover:bg-subtle hover:text-text lg:flex"
                >
                  <PanelRightClose size={15} aria-hidden />
                </button>
              </Tooltip>
            </div>
            <div
              role="tabpanel"
              id="dock-panel"
              aria-labelledby={`dock-${tab}`}
              className="flex min-h-0 flex-1 flex-col"
            >
              {tab === 'steps' &&
                (selected ? (
                  <StepTimeline test={selected} />
                ) : (
                  <p className="px-4 py-3 text-[13px] text-muted">
                    The steps appear once the first test starts.
                  </p>
                ))}
              {tab === 'checks' &&
                (selected ? (
                  <CheckList test={selected} />
                ) : (
                  <p className="px-4 py-3 text-[13px] text-muted">
                    Each test&apos;s checks appear once the plan is ready.
                  </p>
                ))}
              {tab === 'log' && <RunLog logs={state.logs} test={selected ?? null} />}
              {tab === 'plan' && (
                <PlanPanel
                  state={state}
                  planned={!fromSuite}
                  selected={selected?.id}
                  onSelect={setPicked}
                />
              )}
            </div>
          </aside>
        )}
      </div>
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
      <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="pin-lg lg:self-start lg:pr-1">
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

const VIEW_KEY = 'aie2e.runView';
const readView = () => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'developer' ? 'developer' : 'summary';
  } catch {
    return 'summary';
  }
};

/** "Swag Labs" from the pages' own title when every test agrees on it, else the host. */
function appName(info) {
  const titles = new Set(
    (info.report?.results ?? []).map((r) => r.evidence.title?.trim()).filter(Boolean),
  );
  if (titles.size === 1) return [...titles][0];
  const target = info.report?.targetUrl ?? info.options?.url;
  try {
    return new URL(target).host;
  } catch {
    return shortUrl(target);
  }
}

export function RunView({ id, test, visual }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState(readView);
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
  const insights = useMemo(() => (info?.report ? runInsights(info.report) : null), [info?.report]);
  const switchView = (v) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  };

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
        <Skeleton className="h-36 w-full" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </div>
    );

  const target = info.report?.targetUrl ?? info.options?.url;
  const running = info.status === 'running';
  const app = appName(info);
  const who = info.report?.auth?.username;
  const runTitle = who ? `${app}, ${who}` : app;
  const onReview = async (body) => {
    try {
      const { review } = await api.reviewVisual(id, body);
      setInfo((cur) => (cur ? { ...cur, review } : cur));
      toast.success(
        body.action === 'approve'
          ? 'Approved: this screenshot is the new baseline'
          : 'Kept the old baseline: this change counts as a bug',
      );
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (test && info.report && insights)
    return (
      <TestJourney
        runId={id}
        info={info}
        report={info.report}
        insights={insights}
        testId={test}
        focusVisual={visual}
        review={info.review ?? {}}
        onReview={DEMO ? undefined : onReview}
        runTitle={runTitle}
      />
    );

  if (running)
    return (
      <Live
        runId={id}
        onDone={refetch}
        fromSuite={!!info.options?.suite}
        app={app}
        who={who}
        target={target}
        startedAt={info.startedAt}
      />
    );

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
  const total = info.report?.summary.total;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <nav aria-label="Breadcrumb" className="text-[13px] text-muted">
            <a href="#/runs" className="inline-flex items-center gap-1 hover:text-text">
              <ArrowLeft size={13} aria-hidden /> Runs
            </a>{' '}
            / {app}
          </nav>
          <h1 className="truncate text-[26px] font-semibold leading-tight tracking-tight sm:text-[28px]">
            {app}
            {who && <span className="text-muted">, logged in as {who}</span>}
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted">
            <span className="font-mono">{shortUrl(target)}</span>
            {info.options && <span aria-hidden>·</span>}
            {!info.options ? null : info.options.suiteName ? (
              <a className="hover:text-text" href={`#/suites/${info.options.suiteName}`}>
                suite {info.options.suiteName}
              </a>
            ) : info.options?.suite ? (
              <span>suite {String(info.options.suite).split(/[\\/]/).slice(-2).join('/')}</span>
            ) : (
              <span>{info.options?.goal ? 'one goal' : 'tests planned by AI'}</span>
            )}
            {total != null && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {total} test{total === 1 ? '' : 's'}
                </span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>{fmtWhen(info.startedAt)}</span>
            {info.report?.models?.preset && (
              <>
                <span aria-hidden>·</span>
                <span>{info.report.models.preset} models</span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {info.report && (
            <>
              <div
                role="radiogroup"
                aria-label="View"
                className="flex h-9 rounded-lg border border-line bg-subtle p-0.5 text-[13px]"
              >
                {[
                  ['summary', 'Summary'],
                  ['developer', 'Developer view'],
                ].map(([v, label]) => (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={view === v}
                    onClick={() => switchView(v)}
                    className={`rounded-md px-3 font-medium ${view === v ? 'bg-panel text-text shadow-sm' : 'text-muted hover:text-text'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <LinkButton href={fileUrl(id, 'report.html')} target="_blank" rel="noreferrer">
                <FileText size={14} aria-hidden /> Report{' '}
                <ExternalLink size={12} className="text-faint" aria-hidden />
              </LinkButton>
              {!info.options?.suiteName && !DEMO && (
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
              )}
            </>
          )}
          {info.options && !DEMO && (
            <Button variant="accent" onClick={rerun}>
              <RotateCcw size={14} aria-hidden /> Run again
            </Button>
          )}
        </div>
      </header>

      {info.report && insights ? (
        view === 'summary' ? (
          <RunSummary runId={id} report={info.report} insights={insights} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
              <LinkButton href={fileUrl(id, 'report.json')} target="_blank" rel="noreferrer">
                <Braces size={14} aria-hidden /> report.json
              </LinkButton>
              <span className="font-mono">{id}</span>
            </div>
            <Results
              runId={id}
              report={info.report}
              review={info.review ?? {}}
              onReview={onReview}
            />
          </div>
        )
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

/** The current time, ticking every second while `on`, for the live timer. @param {boolean} on */
function useNow(on) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
