import { Check, CircleDashed, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { shortUrl } from '../lib/format.js';
import { Badge } from './ui.jsx';

const PHASES = [
  ['crawl', 'Explore'],
  ['plan', 'Plan'],
  ['run', 'Run tests'],
  ['report', 'Report'],
];

export function PhaseStepper({ phases }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Pipeline progress">
      {PHASES.map(([key, label], i) => {
        const p = phases[key];
        const state = p?.status === 'done' ? 'done' : p?.status === 'running' ? 'running' : 'idle';
        return (
          <li key={key} className="flex items-center gap-1.5">
            {i > 0 && <span className="h-px w-4 bg-line-strong" aria-hidden />}
            <span
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] ${
                state === 'done'
                  ? 'border-ok/25 bg-ok-bg text-ok'
                  : state === 'running'
                    ? 'border-ai/30 bg-ai/10 text-ai'
                    : 'border-line text-faint'
              }`}
            >
              {state === 'done' ? (
                <Check size={12} aria-hidden />
              ) : state === 'running' ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <CircleDashed size={12} aria-hidden />
              )}
              {label}
              {p?.detail && <span className="opacity-75">· {p.detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The browser the agent is driving, streamed live, with its steps as they happen. */
export function LivePanel({ test, frame }) {
  const stepsRef = useRef(null);
  useEffect(() => {
    const el = stepsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [test?.steps.length]);
  if (!test) return null;
  const url = test.screenshots[test.screenshots.length - 1]?.url;
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[20px] font-semibold tracking-tight">{test.title}</h2>
          {test.status === 'running' && (
            <Badge tone="ai">
              <span className="pulse">●</span> live
            </Badge>
          )}
        </div>
        {test.goal && <p className="mt-1 max-w-3xl text-[13px] text-muted">{test.goal}</p>}
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
              alt="Live view of the browser the agent is driving"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-muted">
              {test.status === 'pending'
                ? 'This test has not started yet.'
                : test.status === 'running'
                  ? 'Connecting to the browser…'
                  : 'Finished. The full evidence appears when the run completes.'}
            </div>
          )}
        </div>
      </div>
      <div className="rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold">
          Steps <span className="font-normal text-muted">({test.steps.length})</span>
        </div>
        {test.steps.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-muted">No steps yet.</p>
        ) : (
          <ol ref={stepsRef} className="max-h-72 divide-y divide-line overflow-auto">
            {test.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3 px-4 py-2 text-[13px]">
                <span className="w-5 shrink-0 pt-px text-right font-mono text-[11px] text-faint">
                  {i + 1}
                </span>
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${s.source === 'replay' ? 'bg-user' : 'bg-ai'}`}
                  aria-label={s.source}
                />
                <span className={`min-w-0 break-words ${s.ok === false ? 'text-bad' : ''}`}>
                  {s.description}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
