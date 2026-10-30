import { History, Play, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Dot, EmptyState, LinkButton, Skeleton } from '../components/ui.jsx';
import { fmtTokens, fmtWhen, shortUrl } from '../lib/format.js';

function ResultBar({ s }) {
  if (!s) return <span className="text-faint">–</span>;
  const w = (n) => `${(n / Math.max(1, s.total)) * 100}%`;
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-subtle">
        <div className="bg-ok" style={{ width: w(s.passed) }} />
        <div className="bg-bad" style={{ width: w(s.failed) }} />
        <div className="bg-warn" style={{ width: w(s.errored) }} />
      </div>
      <span className="font-mono text-[12px]">
        {s.passed}/{s.total}
      </span>
    </div>
  );
}

export function Runs() {
  const [runs, setRuns] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const load = () =>
      api
        .runs()
        .then(setRuns)
        .catch(() => setRuns([]));
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);
  const shown = useMemo(
    () => (runs ?? []).filter((r) => r.targetUrl.toLowerCase().includes(q.toLowerCase())),
    [runs, q],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Runs</h1>
          <p className="text-[13px] text-muted">
            Every run is kept with its evidence, so you can see when a test started failing.
          </p>
        </div>
        <LinkButton href="#/new" className="ml-auto">
          <Play size={14} aria-hidden /> New run
        </LinkButton>
      </div>
      {runs === null ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={History}
          title="No runs yet"
          action={<LinkButton href="#/new">Start a run</LinkButton>}
        >
          Point the agent at a URL. It explores the app, plans tests, runs them in a real browser
          and judges each one from evidence.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search size={14} className="text-faint" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by app URL"
              aria-label="Filter runs by app URL"
              className="h-7 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[12px] text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2.5 font-medium">App</th>
                  <th className="px-4 py-2.5 font-medium">Result</th>
                  <th className="px-4 py-2.5 font-medium">Flags</th>
                  <th className="px-4 py-2.5 font-medium">Tokens</th>
                  <th className="px-4 py-2.5 font-medium">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((r) => {
                  const s = r.summary;
                  const tone =
                    r.status === 'running'
                      ? 'ai'
                      : !s
                        ? 'neutral'
                        : s.failed || s.errored
                          ? 'bad'
                          : 'ok';
                  return (
                    <tr
                      key={r.runId}
                      className="cursor-pointer hover:bg-subtle/70"
                      onClick={() => (window.location.hash = `#/runs/${r.runId}`)}
                    >
                      <td className="px-4 py-3">
                        <a
                          href={`#/runs/${r.runId}`}
                          className="flex items-center gap-2.5 font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Dot tone={tone} pulse={r.status === 'running'} />
                          <span className="min-w-0">
                            <span className="block max-w-[360px] truncate">
                              {r.app ?? shortUrl(r.targetUrl)}
                              {r.username && (
                                <span className="font-normal text-muted"> · {r.username}</span>
                              )}
                            </span>
                            {r.app && (
                              <span className="block max-w-[360px] truncate font-mono text-[11px] font-normal text-muted">
                                {shortUrl(r.targetUrl)}
                              </span>
                            )}
                          </span>
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        {r.status === 'running' ? (
                          <Badge tone="ai">Running</Badge>
                        ) : (
                          <span className="flex flex-col gap-1">
                            {r.headline && (
                              <span
                                className={`text-[13px] font-medium ${tone === 'bad' ? 'text-bad' : tone === 'ok' ? 'text-ok' : ''}`}
                              >
                                {r.headline}
                              </span>
                            )}
                            <ResultBar s={s} />
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1">
                          {s?.healed > 0 && <Badge tone="warn">{s.healed} healed</Badge>}
                          {s?.claimMismatches > 0 && (
                            <Badge tone="bad">{s.claimMismatches} claim ≠ evidence</Badge>
                          )}
                          {r.status === 'stopped' && <Badge>stopped</Badge>}
                          {r.status === 'error' && <Badge tone="warn">error</Badge>}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[12px] text-muted">
                        {s
                          ? fmtTokens(
                              s.inputTokens +
                                s.outputTokens +
                                (s.overhead?.inputTokens ?? 0) +
                                (s.overhead?.outputTokens ?? 0),
                            )
                          : '–'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted">
                        {fmtWhen(r.startedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
