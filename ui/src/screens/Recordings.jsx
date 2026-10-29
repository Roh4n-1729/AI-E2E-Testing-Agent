import { AlertDialog } from 'radix-ui';
import { Film, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.js';
import { Badge, Button, EmptyState, Skeleton } from '../components/ui.jsx';
import { go } from '../hooks/useHashRoute.js';
import { fmtWhen } from '../lib/format.js';

const KIND = { act: 'ai', mouse: 'ai', navigate: 'neutral', back: 'neutral', wait: 'neutral' };
const selectorKind = (s) =>
  s?.startsWith('[data-')
    ? ['user', 'test id']
    : s?.startsWith('#')
      ? ['user', 'id']
      : ['neutral', 'XPath'];

function ConfirmDelete({ testId, onConfirm }) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <Button variant="danger" size="sm">
          <Trash2 size={13} aria-hidden /> Delete
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <AlertDialog.Content className="pop-in fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-5 shadow-pop">
          <AlertDialog.Title className="text-[15px] font-semibold">
            Delete this recording?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[13px] text-muted">
            The next run of “{testId}” will use the AI agent again and record a new one.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">Keep it</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="danger" onClick={onConfirm}>
                Delete recording
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function Detail({ id, onDeleted }) {
  const [rec, setRec] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setRec(null);
    setError(null);
    api
      .recording(id)
      .then(setRec)
      .catch((e) => setError(e.message));
  }, [id]);
  if (error) return <p className="text-[13px] text-muted">{error}</p>;
  if (!rec) return <Skeleton className="h-64" />;
  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{rec.testId}</h2>
          <p className="text-[12px] text-muted">
            Recorded {fmtWhen(rec.recordedAt)} · {rec.steps.length} steps
          </p>
        </div>
        <ConfirmDelete
          testId={rec.testId}
          onConfirm={async () => {
            await api.deleteRecording(id);
            toast.success('Recording deleted');
            onDeleted();
          }}
        />
      </div>
      <p className="border-b border-line px-4 py-2.5 text-[12px] text-muted">
        Replayed with plain Playwright and no LLM. If a step stops working, the agent continues from
        the current page and the heal is logged.
      </p>
      <ol className="divide-y divide-line">
        {rec.steps.map((s) => {
          const [tone, label] = selectorKind(s.selector);
          return (
            <li key={s.index} className="flex gap-3 px-4 py-3 text-[13px]">
              <span className="w-5 shrink-0 pt-px text-right font-mono text-[11px] text-faint">
                {s.index}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={KIND[s.kind] ?? 'neutral'}>
                    {s.kind === 'act' ? (s.method ?? 'act') : s.kind}
                  </Badge>
                  <span>{s.description}</span>
                </div>
                {s.selector && (
                  <div className="mt-1.5 flex items-start gap-2">
                    <Badge
                      tone={tone}
                      title={
                        tone === 'user'
                          ? 'Stable selector provided by the app'
                          : 'Position-based selector: works, but breaks when the layout changes'
                      }
                    >
                      {label}
                    </Badge>
                    <code className="min-w-0 break-all font-mono text-[11px] text-muted">
                      {s.selector}
                    </code>
                  </div>
                )}
                {s.fallbackSelectors?.map((f) => (
                  <div key={f} className="mt-1 flex items-start gap-2">
                    <Badge>fallback</Badge>
                    <code className="min-w-0 break-all font-mono text-[11px] text-faint">{f}</code>
                  </div>
                ))}
                {s.arguments?.length > 0 && (
                  <div className="mt-1 font-mono text-[11px] text-muted">
                    {JSON.stringify(s.arguments)}
                  </div>
                )}
                {s.url && (
                  <div className="mt-1 break-all font-mono text-[11px] text-muted">{s.url}</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Recordings({ id }) {
  const [list, setList] = useState(null);
  const load = useCallback(
    () =>
      api
        .recordings()
        .then(setList)
        .catch(() => setList([])),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">Recordings</h1>
        <p className="text-[13px] text-muted">
          Agent runs that passed the judge, saved as plain steps so later runs replay them for free.
        </p>
      </div>
      {list === null ? (
        <Skeleton className="h-40" />
      ) : list.length === 0 ? (
        <EmptyState icon={Film} title="No recordings yet">
          A recording is saved when an agent run passes the judge. Run a test twice to see the
          second run replay without the AI.
        </EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <ul className="space-y-1">
            {list.map((r) => (
              <li key={r.testId}>
                <a
                  href={`#/recordings/${r.testId}`}
                  aria-current={id === r.testId ? 'page' : undefined}
                  className={`block rounded-lg border px-3 py-2.5 ${id === r.testId ? 'border-line-strong bg-panel shadow-sm' : 'border-transparent hover:bg-panel/70'}`}
                >
                  <div className="truncate text-[13px] font-medium">{r.testId}</div>
                  <div className="mt-0.5 text-[12px] text-muted">
                    {r.steps} steps · {fmtWhen(r.recordedAt)}
                  </div>
                </a>
              </li>
            ))}
          </ul>
          {id ? (
            <Detail
              id={id}
              onDeleted={() => {
                load();
                go('#/recordings');
              }}
            />
          ) : (
            <p className="text-[13px] text-muted">
              Pick a recording to see its steps and selectors.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
