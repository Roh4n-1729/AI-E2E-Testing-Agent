import { AlertDialog } from 'radix-ui';
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Copy,
  FileJson,
  ListChecks,
  Play,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.js';
import { Badge, Button, EmptyState, Select, Skeleton } from '../components/ui.jsx';
import { go } from '../hooks/useHashRoute.js';
import { fmtWhen } from '../lib/format.js';

const inputCls =
  'w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13px] outline-none placeholder:text-faint hover:border-line-strong focus:border-user';

/** Every check the judge knows, with the fields people fill in. Guards need no fields. */
const KINDS = {
  'text-visible': { label: 'Text is visible', fields: [['text', 'Text, e.g. Order placed']] },
  url: {
    label: 'Page URL contains',
    fields: [
      ['pattern', 'Part of the URL, e.g. /checkout/done'],
      ['mode', 'select', ['includes', 'regex']],
    ],
  },
  'selector-visible': {
    label: 'Element is visible',
    fields: [['selector', 'CSS selector, e.g. [data-testid="cart-badge"]']],
  },
  'text-appeared': {
    label: 'Message appeared (toast)',
    fields: [['text', 'Text, e.g. Saved']],
  },
  'api-call': {
    label: 'API call was made',
    fields: [
      ['urlPattern', 'URL contains, e.g. /api/orders'],
      ['method', 'Method (optional)'],
      ['status', 'Status (optional)', 'number'],
    ],
  },
  download: {
    label: 'File was downloaded',
    fields: [['filenamePattern', 'Name contains (optional)']],
  },
  visual: { label: 'AI looks at the screen', fields: [['question', 'A yes/no question']] },
  'no-console-errors': { label: 'No console errors', fields: [] },
  'no-network-failures': { label: 'No failed requests', fields: [] },
  'no-a11y-violations': {
    label: 'No accessibility violations',
    fields: [['minImpact', 'select', ['serious', 'critical', 'moderate', 'minor']]],
  },
  'theme-conformance': { label: 'Uses the theme everywhere', fields: [] },
  'visual-baseline': { label: 'Matches approved screenshots', fields: [] },
};
const KIND_OPTIONS = Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label }));

const newTest = () => ({ title: 'New test', goal: '', startUrl: '/', expectations: [] });

/** Test suites: the tests people write and keep, as plain JSON files the CLI runs too. */
export function Suites({ name }) {
  if (name) return <Editor key={name} name={name} />;
  return <SuiteList />;
}

function SuiteList() {
  const [list, setList] = useState(null);
  useEffect(() => {
    api
      .suites()
      .then(setList)
      .catch((e) => toast.error(e.message));
  }, []);
  return (
    <div className="mx-auto max-w-[920px] space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Test suites</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-muted">
            Tests you write and keep. Each one is a goal in plain English plus the checks that prove
            it worked. Tests with recorded steps replay with no AI; the rest are done by the agent
            and recorded once they pass.
          </p>
        </div>
        <Button onClick={() => go('#/suites/new')}>
          <Plus size={14} aria-hidden /> New suite
        </Button>
      </div>
      {!list ? (
        <Skeleton className="h-28 w-full" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No suites yet"
          action={
            <Button onClick={() => go('#/suites/new')}>
              <Plus size={14} aria-hidden /> New suite
            </Button>
          }
        >
          Write tests here, or open a finished run and choose “Save as suite” to keep its tests and
          recorded steps.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((s) => (
            <li key={s.name}>
              <a
                href={`#/suites/${s.name}`}
                className="block h-full rounded-xl border border-line bg-panel p-4 transition-colors hover:border-line-strong"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-[14px] font-medium">{s.name}</span>
                  <span className="shrink-0 text-[12px] text-faint">{fmtWhen(s.updatedAt)}</span>
                </div>
                {s.url && (
                  <div className="mt-0.5 truncate font-mono text-[12px] text-muted">{s.url}</div>
                )}
                {s.description && (
                  <p className="mt-2 line-clamp-2 text-[13px] text-muted">{s.description}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Badge>
                    {s.tests} test{s.tests === 1 ? '' : 's'}
                  </Badge>
                  {s.recorded > 0 && <Badge tone="ok">{s.recorded} recorded</Badge>}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Editor({ name }) {
  const isNew = name === 'new';
  const [suite, setSuite] = useState(
    isNew ? { url: '', description: '', tests: [newTest()] } : null,
  );
  const [saved, setSaved] = useState(isNew ? null : '');
  const [newName, setNewName] = useState('');
  const [issues, setIssues] = useState([]);
  const [busy, setBusy] = useState('');
  const [json, setJson] = useState(null);

  useEffect(() => {
    if (isNew) return;
    api
      .suite(name)
      .then(({ suite: s }) => {
        setSuite({ url: '', description: '', ...s });
        setSaved(JSON.stringify(tidy(s)));
      })
      .catch((e) => toast.error(e.message));
  }, [isNew, name]);

  const clean = useMemo(() => (suite ? tidy(suite) : null), [suite]);
  const dirty = !!clean && JSON.stringify(clean) !== saved;
  const set = (patch) => setSuite((s) => ({ ...s, ...patch }));
  const setTest = (i, patch) =>
    setSuite((s) => ({ ...s, tests: s.tests.map((t, k) => (k === i ? { ...t, ...patch } : t)) }));
  const move = (i, d) =>
    setSuite((s) => {
      const tests = [...s.tests];
      const [t] = tests.splice(i, 1);
      tests.splice(i + d, 0, t);
      return { ...s, tests };
    });

  async function save() {
    const target = isNew ? newName.trim() : name;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(target)) {
      toast.error('Name the suite with lowercase letters, digits and dashes, e.g. checkout-flows');
      return null;
    }
    setBusy('save');
    try {
      const res = await api.saveSuite(target, clean);
      setIssues([]);
      setSaved(JSON.stringify(tidy(res.suite)));
      toast.success('Suite saved');
      if (isNew) go(`#/suites/${target}`);
      return target;
    } catch (e) {
      setIssues(e.message.split('; '));
      toast.error('The suite was not saved: see the problems above the tests');
      return null;
    } finally {
      setBusy('');
    }
  }

  async function run() {
    if (!/^https?:\/\/\S+$/.test(suite.url ?? '')) {
      toast.error('Enter the app URL to run against');
      return;
    }
    const target = dirty || isNew ? await save() : name;
    if (!target) return;
    setBusy('run');
    try {
      const { runId } = await api.startRun({ url: suite.url, suite: target, concurrency: 2 });
      go(`#/runs/${runId}`);
    } catch (e) {
      toast.error(e.message);
      setBusy('');
    }
  }

  async function remove() {
    try {
      await api.deleteSuite(name);
      toast.success('Suite deleted');
      go('#/suites');
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (!suite)
    return (
      <div className="mx-auto max-w-[920px] space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  return (
    <div className="mx-auto max-w-[920px] space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a href="#/suites" className="text-[13px] text-muted hover:text-text">
            ← Test suites
          </a>
          {isNew ? (
            <input
              aria-label="Suite name"
              className={`${inputCls} mt-2 h-10 max-w-sm font-mono text-[15px]`}
              placeholder="suite-name, e.g. checkout-flows"
              value={newName}
              onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            />
          ) : (
            <h1 className="mt-1 truncate font-mono text-[22px] font-semibold tracking-tight">
              {name}
            </h1>
          )}
          <p className="mt-1 text-[12px] text-muted">
            {dirty ? 'Unsaved changes' : isNew ? 'Not saved yet' : 'Saved'} · {suite.tests.length}{' '}
            test
            {suite.tests.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isNew && <ConfirmDelete name={name} onConfirm={remove} />}
          <Button
            variant="secondary"
            onClick={() => setJson(json === null ? JSON.stringify(clean, null, 2) : null)}
          >
            <Braces size={14} aria-hidden /> {json === null ? 'Edit as JSON' : 'Back to form'}
          </Button>
          <Button variant="secondary" disabled={!!busy || (!dirty && !isNew)} onClick={save}>
            <Save size={14} aria-hidden /> {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="accent" disabled={!!busy} onClick={run}>
            <Play size={14} aria-hidden /> {busy === 'run' ? 'Starting…' : 'Run suite'}
          </Button>
        </div>
      </div>

      {issues.length > 0 && (
        <div role="alert" className="rounded-xl border border-bad/30 bg-bad-bg/60 p-3 text-[13px]">
          <p className="font-medium text-bad">Fix these before saving:</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-[12px]">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      {json !== null ? (
        <JsonEditor
          value={json}
          onChange={setJson}
          onApply={(parsed) => {
            setSuite({ url: '', description: '', ...parsed });
            setJson(null);
          }}
        />
      ) : (
        <>
          <div className="grid gap-4 rounded-xl border border-line bg-panel p-5 sm:grid-cols-2">
            <label className="block text-[13px] font-medium">
              App URL
              <span className="block text-[12px] font-normal text-muted">
                Where the suite runs. Start pages below are relative to it.
              </span>
              <input
                type="url"
                className={`${inputCls} mt-1.5 font-mono`}
                placeholder="https://staging.your-app.com"
                value={suite.url ?? ''}
                onChange={(e) => set({ url: e.target.value })}
              />
            </label>
            <label className="block text-[13px] font-medium">
              Log in first
              <span className="block text-[12px] font-normal text-muted">
                Optional login page. Username and password come from AIE2E_USERNAME and
                AIE2E_PASSWORD in .env, never from this file.
              </span>
              <input
                className={`${inputCls} mt-1.5 font-mono`}
                placeholder="/login"
                value={suite.auth?.loginUrl ?? ''}
                onChange={(e) => set({ auth: { ...suite.auth, loginUrl: e.target.value } })}
              />
            </label>
            <label className="block text-[13px] font-medium">
              Text that shows the login worked
              <span className="block text-[12px] font-normal text-muted">
                Optional. Default: the password field is gone.
              </span>
              <input
                className={`${inputCls} mt-1.5`}
                placeholder="e.g. Welcome back"
                value={suite.auth?.successText ?? ''}
                onChange={(e) => set({ auth: { ...suite.auth, successText: e.target.value } })}
              />
            </label>
            <label className="block text-[13px] font-medium">
              Compare the theme with another product
              <span className="block text-[12px] font-normal text-muted">
                Optional. Checked against that product&apos;s themes instead of this app&apos;s own.
              </span>
              <input
                type="url"
                className={`${inputCls} mt-1.5 font-mono`}
                placeholder="https://design.your-company.com"
                value={suite.themeFrom ?? ''}
                onChange={(e) => set({ themeFrom: e.target.value })}
              />
            </label>
            <label className="block text-[13px] font-medium">
              What is this suite about?
              <span className="block text-[12px] font-normal text-muted">Optional</span>
              <input
                className={`${inputCls} mt-1.5`}
                placeholder="Checkout flows of the shop"
                value={suite.description ?? ''}
                onChange={(e) => set({ description: e.target.value })}
              />
            </label>
          </div>

          <ol className="space-y-4">
            {suite.tests.map((t, i) => (
              <TestCard
                key={i}
                index={i}
                test={t}
                count={suite.tests.length}
                onChange={(patch) => setTest(i, patch)}
                onMove={(d) => move(i, d)}
                onDuplicate={() =>
                  setSuite((s) => ({
                    ...s,
                    tests: [
                      ...s.tests.slice(0, i + 1),
                      { ...structuredClone(t), id: undefined, title: `${t.title} (copy)` },
                      ...s.tests.slice(i + 1),
                    ],
                  }))
                }
                onRemove={() =>
                  setSuite((s) => ({ ...s, tests: s.tests.filter((_, k) => k !== i) }))
                }
              />
            ))}
          </ol>
          <Button variant="secondary" onClick={() => set({ tests: [...suite.tests, newTest()] })}>
            <Plus size={14} aria-hidden /> Add a test
          </Button>
          <p className="text-[12px] text-muted">
            <FileJson size={12} className="inline" aria-hidden /> Saved as{' '}
            <code className="font-mono">{isNew ? newName || '<name>' : name}.suite.json</code>: the
            same file <code className="font-mono">aie2e run &lt;url&gt; --suite</code> runs in CI.
          </p>
        </>
      )}
    </div>
  );
}

function TestCard({ index, test, count, onChange, onMove, onDuplicate, onRemove }) {
  const exps = test.expectations ?? [];
  const setExp = (k, patch) =>
    onChange({ expectations: exps.map((e, j) => (j === k ? { ...e, ...patch } : e)) });
  return (
    <li className="rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[12px] text-faint">
          {String(index + 1).padStart(2, '0')}
        </span>
        <input
          aria-label={`Test ${index + 1} title`}
          className="min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none placeholder:text-faint"
          placeholder="What does this test check?"
          value={test.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        {test.steps?.length > 0 && <Badge tone="ok">{test.steps.length} recorded steps</Badge>}
        <IconButton
          label="Move up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          icon={ArrowUp}
        />
        <IconButton
          label="Move down"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          icon={ArrowDown}
        />
        <IconButton label="Duplicate" onClick={onDuplicate} icon={Copy} />
        <IconButton label="Remove test" disabled={count === 1} onClick={onRemove} icon={Trash2} />
      </div>
      <div className="grid gap-4 p-4 md:grid-cols-[200px_minmax(0,1fr)]">
        <label className="block text-[12px] font-medium text-muted">
          Start page
          <input
            className={`${inputCls} mt-1 font-mono`}
            placeholder="/"
            value={test.startUrl ?? '/'}
            onChange={(e) => onChange({ startUrl: e.target.value })}
          />
        </label>
        <label className="block text-[12px] font-medium text-muted">
          Goal, in plain English{' '}
          <span className="font-normal text-faint">
            (empty = just check the page loads cleanly)
          </span>
          <textarea
            className={`${inputCls} mt-1 min-h-[64px]`}
            placeholder="e.g. Add the mug to the cart, then open the cart"
            value={test.goal ?? ''}
            onChange={(e) => onChange({ goal: e.target.value })}
          />
        </label>
      </div>
      <div className="space-y-2 px-4 pb-4">
        <div className="text-[12px] font-medium text-muted">
          Checks that prove it worked{' '}
          <span className="font-normal text-faint">
            (no console errors and no failed requests are always checked)
          </span>
        </div>
        {exps.map((e, k) => (
          <ExpectationRow
            key={k}
            exp={e}
            onChange={(patch) => setExp(k, patch)}
            onKind={(kind) =>
              onChange({ expectations: exps.map((x, j) => (j === k ? { kind } : x)) })
            }
            onRemove={() => onChange({ expectations: exps.filter((_, j) => j !== k) })}
          />
        ))}
        <button
          type="button"
          onClick={() => onChange({ expectations: [...exps, { kind: 'text-visible', text: '' }] })}
          className="text-[13px] font-medium text-user hover:underline"
        >
          + Add a check
        </button>
        {test.steps?.length > 0 && (
          <details className="rounded-lg bg-subtle px-3 py-2 text-[12px]">
            <summary className="cursor-pointer text-muted">
              Recorded steps: replayed with no AI. If you change what the test does, clear them so
              the agent records it again.
            </summary>
            <ol className="mt-2 list-decimal space-y-0.5 pl-5">
              {test.steps.map((s, k) => (
                <li key={k}>
                  {s.description}{' '}
                  {s.selector && <span className="font-mono text-faint">{s.selector}</span>}
                </li>
              ))}
            </ol>
            <button
              type="button"
              onClick={() => onChange({ steps: undefined })}
              className="mt-2 font-medium text-bad hover:underline"
            >
              Clear recorded steps
            </button>
          </details>
        )}
      </div>
    </li>
  );
}

function ExpectationRow({ exp, onChange, onKind, onRemove }) {
  const def = KINDS[exp.kind] ?? { label: exp.kind, fields: [] };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-[230px] shrink-0">
        <Select value={exp.kind} onValueChange={onKind} options={KIND_OPTIONS} label="Check" />
      </div>
      {def.fields.map(([field, hint, type]) =>
        hint === 'select' ? (
          <div key={field} className="w-[140px]">
            <Select
              value={exp[field] ?? type[0]}
              onValueChange={(v) => onChange({ [field]: v })}
              options={type.map((v) => ({ value: v, label: v }))}
              label={field}
            />
          </div>
        ) : (
          <input
            key={field}
            aria-label={hint}
            type={type === 'number' ? 'number' : 'text'}
            className={`${inputCls} h-9 min-w-[160px] flex-1`}
            placeholder={hint}
            value={exp[field] ?? ''}
            onChange={(e) =>
              onChange({
                [field]:
                  type === 'number'
                    ? e.target.value === ''
                      ? undefined
                      : Number(e.target.value)
                    : e.target.value,
              })
            }
          />
        ),
      )}
      <input
        aria-label="In plain words (shown in reports)"
        className={`${inputCls} h-9 min-w-[200px] flex-1`}
        placeholder="In plain words, e.g. The cart shows 2 products"
        value={exp.label ?? ''}
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <IconButton label="Remove check" onClick={onRemove} icon={X} />
    </div>
  );
}

function JsonEditor({ value, onChange, onApply }) {
  const [error, setError] = useState('');
  return (
    <div className="space-y-2">
      <textarea
        aria-label="Suite JSON"
        spellCheck={false}
        className={`${inputCls} min-h-[420px] font-mono text-[12px] leading-relaxed`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <p className="text-[12px] text-bad">{error}</p>}
      <Button
        variant="secondary"
        onClick={() => {
          try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed.tests)) throw new Error('"tests" must be a list');
            setError('');
            onApply(parsed);
          } catch (e) {
            setError(`Not valid: ${e.message}`);
          }
        }}
      >
        Apply JSON
      </Button>
    </div>
  );
}

function IconButton({ label, icon: Icon, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-muted hover:bg-subtle hover:text-text disabled:opacity-30"
      {...rest}
    >
      <Icon size={14} aria-hidden />
    </button>
  );
}

function ConfirmDelete({ name, onConfirm }) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <Button variant="danger">
          <Trash2 size={14} aria-hidden /> Delete
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <AlertDialog.Content className="pop-in fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-5 shadow-pop">
          <AlertDialog.Title className="text-[15px] font-semibold">
            Delete “{name}”?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[13px] text-muted">
            The suite file is removed. Runs that used it keep their reports.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">Keep it</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="danger" onClick={onConfirm}>
                Delete suite
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/**
 * What gets saved: empty optional fields dropped, and fields of a previous check kind removed, so the
 * file stays as clean as one written by hand.
 */
function tidy(suite) {
  const keep = (e) => {
    const allowed = new Set(['kind', 'label', ...(KINDS[e.kind]?.fields ?? []).map(([f]) => f)]);
    return Object.fromEntries(
      Object.entries(e).filter(([k, v]) => allowed.has(k) && v !== '' && v !== undefined),
    );
  };
  return {
    ...(suite.description?.trim() ? { description: suite.description.trim() } : {}),
    ...(suite.url?.trim() ? { url: suite.url.trim() } : {}),
    ...(suite.themeFrom?.trim() ? { themeFrom: suite.themeFrom.trim() } : {}),
    ...(suite.auth?.loginUrl?.trim()
      ? {
          auth: Object.fromEntries(
            Object.entries({ ...suite.auth, loginUrl: suite.auth.loginUrl.trim() }).filter(
              ([, v]) => v !== '' && v !== undefined,
            ),
          ),
        }
      : {}),
    // known third-party noise (edited in JSON mode); kept as is so saving in the editor never drops it
    ...(suite.ignore?.network?.length || suite.ignore?.console?.length
      ? { ignore: suite.ignore }
      : {}),
    tests: suite.tests.map((t) => ({
      ...(t.id ? { id: t.id } : {}),
      title: t.title,
      goal: t.goal ?? '',
      startUrl: t.startUrl || '/',
      expectations: (t.expectations ?? []).map(keep),
      ...(t.steps?.length ? { steps: t.steps } : {}),
      ...(t.maxSteps ? { maxSteps: t.maxSteps } : {}),
      tags: t.tags ?? [],
    })),
  };
}
