import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDuration, fmtTokens, fmtWhen } from '../lib/format.js';

/**
 * This run against the previous run of the same app: which tests got fixed or broke, what is new, and what it
 * cost, plus the app's last runs as a strip. Another run can be picked to compare with. Everything comes from
 * the server's run digests (`reporter/compare.js`).
 */

/** A test's journey (the same address RunSummary links to). */
const testHref = (/** @type {string} */ runId, /** @type {string} */ testId) =>
  `#/runs/${runId}/tests/${encodeURIComponent(testId)}`;

const TREND = {
  better: { label: 'Better', cls: 'bg-ok-bg text-ok', Icon: ArrowUpRight },
  worse: { label: 'Worse', cls: 'bg-bad-bg text-bad', Icon: ArrowDownRight },
  mixed: { label: 'Mixed', cls: 'bg-warn-bg text-warn', Icon: Minus },
  same: { label: 'Same results', cls: 'bg-subtle text-muted', Icon: Minus },
};
const CHANGE = {
  broke: ['Newly failing', 'text-bad'],
  fixed: ['Fixed', 'text-ok'],
  'still-failing': ['Still failing', 'text-warn'],
  new: ['New test', 'text-user'],
  removed: ['No longer run', 'text-muted'],
  'not-finished': ['Not finished', 'text-muted'],
};

/** The app's address without the scheme, for the empty state. */
const appLabel = (/** @type {string} */ url) =>
  (url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');

/** "+1m 05s" / "−12s", "+3.2k" / "−40k"; zero shows as "same". */
const signed = (/** @type {number} */ n, /** @type {(n: number) => string} */ fmt) =>
  n === 0 ? 'same' : `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}`;

/** @param {{ runId: string }} props */
export function SinceLastRun({ runId }) {
  const [withId, setWithId] = useState('');
  const [data, setData] = useState(/** @type {any} */ (null));
  const [history, setHistory] = useState(/** @type {any[]} */ ([]));
  useEffect(() => {
    let live = true;
    api
      .compare(runId, withId || undefined)
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [runId, withId]);
  useEffect(() => {
    api
      .history(runId)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [runId]);

  if (!data) return null;
  const c = data.comparison;
  return (
    <section aria-labelledby="since-h" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="since-h" className="text-[18px] font-semibold">
            {withId ? 'Compared with another run' : 'Since the last run'}
          </h2>
          {data.previous && (
            <p className="text-[13px] text-muted">
              Against the run of {fmtWhen(data.previous.startedAt)}: {data.previous.headline}
              {data.previous.stopped ? ' (stopped)' : ''}
              {data.previous.otherSuite && (
                <span className="block text-[12px]">
                  That run{' '}
                  {data.previous.suite
                    ? `used the suite ${data.previous.suite}`
                    : 'planned its own tests'}
                  ; tests are matched by id, then by title.
                </span>
              )}
            </p>
          )}
        </div>
        {data.others.length > 0 && (
          <label className="flex items-center gap-2 text-[13px] text-muted">
            Compare with
            <select
              value={withId}
              onChange={(e) => setWithId(e.target.value)}
              className="h-8 max-w-[280px] rounded-lg border border-line bg-panel px-2 text-[13px] text-text"
            >
              <option value="">the previous run</option>
              {data.others.map((o) => (
                <option key={o.runId} value={o.runId}>
                  {fmtWhen(o.startedAt)} · {o.headline}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!c ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-3 text-[14px] text-muted">
          No earlier finished run of this app ({appLabel(data.current.targetUrl)}) to compare with.
          Runs are compared within one app, because another app has other tests. The next run of
          this app will be compared with this one.
        </p>
      ) : (
        <div className="rounded-xl border border-line bg-panel">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-3">
            <Trend trend={c.trend} />
            <span className="text-[15px] font-medium">{c.sentence}</span>
            <span className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
              <span>time {signed(c.delta.durationMs, fmtDuration)}</span>
              <span>tokens {signed(c.delta.tokens, fmtTokens)}</span>
              {c.delta.nowReplayed > 0 && (
                <span className="text-ok">
                  {c.delta.nowReplayed} now replay{c.delta.nowReplayed === 1 ? 's' : ''} with no AI
                </span>
              )}
            </span>
          </div>
          {history.length > 1 && <HistoryStrip history={history} runId={runId} />}
          <ChangeList comparison={c} runId={runId} previousId={data.previous.runId} />
          {(c.problems.newProblems.length > 0 || c.problems.resolvedProblems.length > 0) && (
            <div className="grid gap-4 border-t border-line px-4 py-3 text-[13px] sm:grid-cols-2">
              <ProblemList title="New problems" items={c.problems.newProblems} cls="text-bad" />
              <ProblemList
                title="Problems gone"
                items={c.problems.resolvedProblems}
                cls="text-ok"
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Trend({ trend }) {
  const t = TREND[trend] ?? TREND.same;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${t.cls}`}
    >
      <t.Icon size={13} aria-hidden /> {t.label}
    </span>
  );
}

/** The app's recent runs: one bar per run, its height the share of tests that passed. */
function HistoryStrip({ history, runId }) {
  return (
    <div className="flex items-end gap-1 overflow-x-auto border-b border-line px-4 pb-3 pt-3">
      <span className="mr-2 self-center text-[12px] text-muted">Last runs</span>
      {history.map((h) => {
        const share = h.total ? h.passed / h.total : 0;
        const here = h.runId === runId;
        return (
          <a
            key={h.runId}
            href={`#/runs/${h.runId}`}
            title={`${fmtWhen(h.startedAt)}: ${h.passed} of ${h.total} passed${h.stopped ? ' (stopped)' : ''}, ${fmtTokens(h.tokens)} tokens`}
            aria-label={`Run of ${fmtWhen(h.startedAt)}: ${h.passed} of ${h.total} passed`}
            aria-current={here ? 'true' : undefined}
            className={`flex h-10 w-3 shrink-0 flex-col justify-end rounded-sm bg-subtle ${here ? 'ring-2 ring-text ring-offset-1 ring-offset-panel' : ''}`}
          >
            <span
              className={`block rounded-sm ${share === 1 ? 'bg-ok' : h.stopped ? 'bg-line-strong' : 'bg-warn'}`}
              style={{ height: `${Math.max(8, share * 100)}%` }}
            />
          </a>
        );
      })}
    </div>
  );
}

function ChangeList({ comparison, runId, previousId }) {
  const changed = comparison.tests.filter((t) => t.change !== 'passing');
  const passing = comparison.tests.length - changed.length;
  return (
    <ul className="divide-y divide-line">
      {changed.map((t) => {
        const [label, cls] = CHANGE[t.change];
        const href = t.now ? testHref(runId, t.id) : testHref(previousId, t.id);
        return (
          <li key={`${t.change}-${t.id}`}>
            <a
              href={href}
              className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 px-4 py-2.5 text-[14px] hover:bg-subtle/60"
            >
              <span className={`text-[13px] font-medium ${cls}`}>{label}</span>
              <span className="min-w-0">
                <span className="font-medium">{t.title}</span>
                {(t.now?.reason || t.before?.reason) && t.change !== 'fixed' && (
                  <span className="block truncate text-[12px] text-muted">
                    {t.now?.reason ?? t.before?.reason}
                  </span>
                )}
              </span>
            </a>
          </li>
        );
      })}
      {passing > 0 && (
        <li className="px-4 py-2.5 text-[13px] text-muted">
          {passing} test{passing === 1 ? '' : 's'} passed in both runs
        </li>
      )}
    </ul>
  );
}

function ProblemList({ title, items, cls }) {
  if (!items.length) return <div />;
  return (
    <div>
      <h3 className={`mb-1 font-semibold ${cls}`}>{title}</h3>
      <ul className="flex flex-col gap-0.5 text-muted">
        {items.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}
