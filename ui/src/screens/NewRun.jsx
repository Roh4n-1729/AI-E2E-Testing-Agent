import { AlertTriangle, ChevronDown, Compass, Play, Route, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.js';
import { Button, Kbd, Select, Switch } from '../components/ui.jsx';
import { go } from '../hooks/useHashRoute.js';

const STORAGE_KEY = 'aie2e:last-form';
const DEFAULTS = {
  mode: 'explore',
  url: '',
  description: '',
  goal: '',
  expectText: '',
  concurrency: 2,
  maxTests: 4,
  cache: true,
  rerecord: false,
  replan: false,
  headed: false,
  quality: 'warn',
};

const MODES = [
  {
    id: 'explore',
    icon: Compass,
    title: 'Explore and plan',
    text: 'The AI explores the app, writes the tests and runs them.',
  },
  {
    id: 'flow',
    icon: Route,
    title: 'Test one flow',
    text: 'Describe a single user journey in plain English.',
  },
  {
    id: 'smoke',
    icon: ShieldCheck,
    title: 'Smoke check',
    text: 'Load the page and check errors and quality. No AI needed.',
  },
];

function loadForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      ...DEFAULTS,
      ...saved,
      mode: saved.mode ?? (saved.useAi === false ? 'smoke' : 'explore'),
    };
  } catch {
    return DEFAULTS;
  }
}

const inputCls =
  'w-full rounded-lg border border-line bg-panel px-3 py-2 text-[14px] outline-none placeholder:text-faint hover:border-line-strong focus:border-user';

function Field({ id, label, hint, children }) {
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

export function NewRun({ health }) {
  const [form, setForm] = useState(loadForm);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const needsAi = form.mode !== 'smoke';
  const noChrome = health && !health.chromeOk;
  const keyMissing = health && !health.keyPresent && needsAi;
  const urlOk = /^https?:\/\/\S+$/.test(form.url.trim());

  async function submit(e) {
    e.preventDefault();
    if (!urlOk) return toast.error('Enter the full URL, starting with http:// or https://');
    if (form.mode === 'flow' && !form.goal.trim()) return toast.error('Describe the flow to test');
    setBusy(true);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {
      /* private mode */
    }
    const expectText = form.expectText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const { runId } = await api.startRun({
        url: form.url.trim(),
        description: form.mode === 'explore' ? form.description.trim() || undefined : undefined,
        goal: form.mode === 'flow' ? form.goal.trim() : undefined,
        expectText: form.mode === 'flow' && expectText.length ? expectText : undefined,
        concurrency: Number(form.concurrency),
        maxTests: Number(form.maxTests),
        plan: form.mode === 'explore',
        crawl: form.mode === 'explore',
        cache: form.cache,
        rerecord: form.rerecord,
        replan: form.replan,
        headed: form.headed,
        quality: form.quality,
      });
      go(`#/runs/${runId}`);
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-[760px] space-y-6">
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">Test a web app</h1>
        <p className="mt-1 text-[13px] text-muted">
          An AI agent drives a real browser. Pass or fail is decided from evidence it cannot fake:
          the page, the network, downloads and screenshots.
        </p>
      </div>

      {(noChrome || keyMissing) && (
        <div
          role="alert"
          className="flex gap-2.5 rounded-xl border border-warn/30 bg-warn-bg/60 p-3 text-[13px]"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          <div>
            {noChrome && (
              <p>
                No Chrome or Chromium was found. Install one, or run <Kbd>npm run browsers</Kbd>.
              </p>
            )}
            {keyMissing && (
              <p>
                <Kbd>{health.keyVar}</Kbd> is not set, so AI planning and agent runs will fail. Add
                it to <Kbd>.env</Kbd> and restart, or choose Smoke check.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-line bg-panel p-5 shadow-sm">
        <Field id="url" label="App URL">
          <input
            id="url"
            type="url"
            required
            autoFocus
            className={`${inputCls} h-11 font-mono text-[14px]`}
            placeholder="https://your-app.example.com"
            value={form.url}
            onChange={(e) => set({ url: e.target.value })}
          />
        </Field>

        <div className="mt-5 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="What to test">
          {MODES.map((m) => {
            const Icon = m.icon;
            const on = form.mode === m.id;
            return (
              <button
                type="button"
                key={m.id}
                role="radio"
                aria-checked={on}
                onClick={() => set({ mode: m.id })}
                className={`rounded-lg border p-3 text-left transition-colors ${on ? 'border-user bg-user/5 ring-1 ring-user/40' : 'border-line hover:border-line-strong'}`}
              >
                <Icon size={16} className={on ? 'text-user' : 'text-muted'} aria-hidden />
                <div className="mt-2 text-[13px] font-medium">{m.title}</div>
                <div className="mt-0.5 text-[12px] leading-snug text-muted">{m.text}</div>
              </button>
            );
          })}
        </div>

        <div className="mt-5 space-y-4">
          {form.mode === 'explore' && (
            <Field
              id="desc"
              label="What is this app?"
              hint="Optional, but it makes the plan much better."
            >
              <textarea
                id="desc"
                className={`${inputCls} min-h-[76px]`}
                placeholder="An AI presentation builder: describe a topic, it generates a deck you can edit, theme, present and export."
                value={form.description}
                onChange={(e) => set({ description: e.target.value })}
              />
            </Field>
          )}
          {form.mode === 'flow' && (
            <>
              <Field id="goal" label="The flow to test" hint="Plain English, from the start page.">
                <textarea
                  id="goal"
                  className={`${inputCls} min-h-[76px]`}
                  placeholder="Open the sample deck, open Export and download it as PowerPoint."
                  value={form.goal}
                  onChange={(e) => set({ goal: e.target.value })}
                />
              </Field>
              <Field
                id="expect"
                label="Text that must be visible at the end"
                hint="Optional. One per line."
              >
                <textarea
                  id="expect"
                  className={`${inputCls} min-h-[52px]`}
                  value={form.expectText}
                  onChange={(e) => set({ expectText: e.target.value })}
                />
              </Field>
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel">
        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          aria-expanded={advanced}
          className="flex w-full items-center gap-2 px-5 py-3.5 text-[13px] font-medium"
        >
          Run settings
          <span className="font-normal text-muted">
            {form.concurrency} in parallel · quality {form.quality} · replay{' '}
            {form.cache ? 'on' : 'off'}
          </span>
          <ChevronDown
            size={15}
            className={`ml-auto text-faint transition-transform ${advanced ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
        {advanced && (
          <div className="space-y-5 border-t border-line px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="conc" label="Tests in parallel">
                <Select
                  id="conc"
                  label="Tests in parallel"
                  value={form.concurrency}
                  onValueChange={(v) => set({ concurrency: Number(v) })}
                  options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
                />
              </Field>
              <Field id="max" label="Planned tests">
                <Select
                  id="max"
                  label="Planned tests"
                  value={form.maxTests}
                  onValueChange={(v) => set({ maxTests: Number(v) })}
                  options={[2, 3, 4, 5, 6, 8].map((n) => ({ value: n, label: `Up to ${n}` }))}
                />
              </Field>
              <Field id="q" label="Quality gate">
                <Select
                  id="q"
                  label="Quality gate"
                  value={form.quality}
                  onValueChange={(v) => set({ quality: v })}
                  options={[
                    {
                      value: 'warn',
                      label: 'Warn',
                      hint: 'Report Web Vitals and accessibility issues',
                    },
                    { value: 'fail', label: 'Fail', hint: 'A clear problem fails the test' },
                    { value: 'off', label: 'Off', hint: 'Functional checks only' },
                  ]}
                />
              </Field>
            </div>
            <div className="divide-y divide-line">
              <Switch
                id="cache"
                checked={form.cache}
                onCheckedChange={(v) => set({ cache: v })}
                label="Replay recordings"
                hint="Tests that passed before replay with plain Playwright: no AI, no tokens, seconds instead of minutes."
              />
              <Switch
                id="rerec"
                checked={form.rerecord}
                onCheckedChange={(v) => set({ rerecord: v })}
                label="Record again"
                hint="Ignore saved recordings and let the agent do every test again."
              />
              <Switch
                id="replan"
                checked={form.replan}
                onCheckedChange={(v) => set({ replan: v })}
                label="Plan again"
                hint="Ignore the saved test plan for this URL."
              />
              <Switch
                id="headed"
                checked={form.headed}
                onCheckedChange={(v) => set({ headed: v })}
                label="Open a real browser window too"
                hint="The live view works without it."
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button
          type="submit"
          variant="accent"
          busy={busy}
          disabled={!!noChrome || busy}
          className="h-10 px-5"
        >
          <Play size={14} aria-hidden /> Start run
        </Button>
        <span className="text-[12px] text-muted">
          One run at a time. Each test gets its own browser.
        </span>
      </div>
    </form>
  );
}
