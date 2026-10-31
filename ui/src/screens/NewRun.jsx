import { AlertTriangle, ChevronDown, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DEMO, api } from '../api.js';
import { Button, Kbd, Select, Switch } from '../components/ui.jsx';
import { ACTORS } from '../components/WhoDidWhat.jsx';
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
  visual: 'warn',
  preset: 'env',
  agentEngine: 'env',
  loginUrl: '',
  loginSuccess: '',
  themeFrom: '',
};

/** "anthropic/claude-sonnet-4-6" -> "sonnet-4-6" */
const short = (m = '') => m.replace(/^[a-z]+\//, '').replace(/^claude-/, '');

const MODES = [
  {
    id: 'explore',
    title: 'Explore and plan',
    text: 'It finds the flows itself, writes the tests and runs them.',
    ai: 'Planner and agent',
  },
  {
    id: 'flow',
    title: 'Test one flow',
    text: 'You describe one user journey in plain English.',
    ai: 'Agent',
  },
  {
    id: 'smoke',
    title: 'Smoke check',
    text: 'Loads the page and checks for errors and quality problems.',
    ai: 'No AI',
  },
];

/** The host of a URL the person is still typing, or a placeholder. @param {string} url */
const hostOf = (url) => {
  try {
    return new URL(url.trim()).host || 'the app';
  } catch {
    return 'the app';
  }
};
const clip = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The models this run will use: the preset picked here, or the ones from .env. */
function modelsFor(form, health) {
  const m = form.preset !== 'env' ? health?.presets?.[form.preset] : health;
  return m
    ? { agent: short(m.model), planner: short(m.plannerModel), judge: short(m.judgeModel) }
    : {};
}

/**
 * Who does what in this run, in order, from the form as it is now: the hand-offs between Playwright,
 * the AI and the judge that the run screen will show.
 * @returns {{ actor: 'playwright' | 'agent' | 'judge', who: string, model?: string, text: string }[]}
 */
function runSequence(form, health) {
  const host = hostOf(form.url);
  const models = modelsFor(form, health);
  const login = form.loginUrl.trim()
    ? `, logs in ${form.loginUrl.trim() === '/' ? 'on the start page' : `at ${form.loginUrl.trim()}`} with the account in .env (the AI never sees the password)`
    : '';
  const judge = {
    actor: 'judge',
    who: 'Judge',
    text: 'Decides pass or fail from the final page, the URL, the console, failed requests and screenshots. What the agent says about itself does not count.',
  };
  const agentRuns = form.rerecord
    ? 'Does every test again in its own browser, ignoring saved recordings.'
    : form.cache
      ? 'Does each new test in its own browser. A test that passed before is replayed by Playwright with no AI, and the agent only steps in if a step breaks.'
      : 'Does every test in its own browser. Nothing is replayed.';

  if (form.mode === 'smoke')
    return [
      {
        actor: 'playwright',
        who: 'Playwright',
        text: `Opens ${host}${login}, and collects console errors, failed requests, Web Vitals and accessibility issues.`,
      },
      { ...judge, text: 'Passes the page if nothing went wrong. No AI and no tokens.' },
    ];
  if (form.mode === 'flow') {
    const expect = form.expectText
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    return [
      { actor: 'playwright', who: 'Playwright', text: `Opens ${host}${login}.` },
      {
        actor: 'agent',
        who: 'AI agent',
        model: models.agent,
        text: form.goal.trim()
          ? `Follows your flow: “${clip(form.goal.trim())}” Playwright records each step so the next run replays it.`
          : 'Follows the flow you describe. Playwright records each step so the next run replays it.',
      },
      {
        ...judge,
        model: undefined,
        text: expect.length
          ? `Checks that “${clip(expect.join('”, “'), 70)}” is on the final page, and that the app logged no errors.`
          : judge.text,
      },
    ];
  }
  return [
    {
      actor: 'playwright',
      who: 'Playwright',
      text: `Opens ${host}${login}, and explores the pages it can reach on the same site.`,
    },
    {
      actor: 'agent',
      who: 'AI planner',
      model: models.planner,
      text: `Writes up to ${form.maxTests} tests from what was found${form.description.trim() ? ' and your description' : ''}, each with checks that prove it worked. A review then drops checks that could never fail.`,
    },
    { actor: 'agent', who: 'AI agent', model: models.agent, text: agentRuns },
    judge,
  ];
}

/** The settings, in words, for the closed settings row. */
function settingsSummary(form) {
  const parts = [
    `${form.concurrency} ${form.concurrency === 1 ? 'test' : 'tests'} at a time`,
    form.cache ? 'replays on' : 'replays off',
    form.preset === 'env' ? 'models from .env' : `${form.preset} models`,
  ];
  if (form.loginUrl.trim()) parts.push('logs in first');
  return parts.join(', ');
}

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
  const noChrome = !DEMO && health && !health.chromeOk;
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
        visual: form.visual,
        preset: form.preset === 'env' ? undefined : form.preset,
        agentEngine: form.agentEngine === 'env' ? undefined : form.agentEngine,
        themeFrom: /^https?:\/\/\S+$/.test(form.themeFrom.trim())
          ? form.themeFrom.trim()
          : undefined,
        auth: form.loginUrl.trim()
          ? { loginUrl: form.loginUrl.trim(), successText: form.loginSuccess.trim() || undefined }
          : undefined,
      });
      go(`#/runs/${runId}`);
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  }

  const steps = runSequence(form, health);

  return (
    <form
      onSubmit={submit}
      className="mx-auto grid max-w-[1180px] gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_380px]"
    >
      <div className="min-w-0 space-y-6">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Test a web app</h1>
          <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-muted">
            Give it a URL. AI writes and runs the tests in a real browser, Playwright replays the
            ones that pass, and a judge decides from evidence the AI cannot fake.
          </p>
        </div>

        {health?.shared && (
          <div className="rounded-xl border border-line bg-panel p-4 text-[13px] leading-relaxed">
            <p className="font-semibold">A shared instance</p>
            <p className="mt-0.5 text-muted">
              Runs use its owner’s AI account: up to {health.shared.maxTests} planned tests,{' '}
              {health.shared.concurrency === 1
                ? 'one at a time'
                : `${health.shared.concurrency} at a time`}
              . Any public web app works. These apps run next to it:
            </p>
            {health.shared.apps.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {health.shared.apps.map((a) => (
                  <button
                    key={a.url}
                    type="button"
                    onClick={() => set({ url: a.url })}
                    className="rounded-lg border border-line px-2.5 py-1 text-[13px] font-medium hover:border-user hover:text-user"
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {DEMO && (
          <div className="rounded-xl border border-user/25 bg-user/[0.07] p-4 text-[14px] leading-relaxed">
            <p className="font-semibold">This form starts a run on your own machine.</p>
            <p className="mt-1 text-muted">
              The showcase is read-only: open{' '}
              <a className="font-medium text-user hover:underline" href="#/runs">
                Runs
              </a>{' '}
              to explore real runs, their journeys and screenshots. To test your own app, clone{' '}
              <a
                className="font-medium text-user hover:underline"
                href="https://github.com/Roh4n-1729/AI-E2E-Testing-Agent"
                target="_blank"
                rel="noreferrer"
              >
                the repository
              </a>{' '}
              and run <Kbd>npm run ui</Kbd>.
            </p>
          </div>
        )}

        {(noChrome ||
          keyMissing ||
          (needsAi && health?.agentWarning && form.agentEngine !== 'loop')) && (
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
                  <Kbd>{health.keyVar}</Kbd> is not set, so AI planning and agent runs will fail.
                  Add it to <Kbd>.env</Kbd> and restart, or choose Smoke check.
                </p>
              )}
              {needsAi && health?.agentWarning && form.agentEngine !== 'loop' && (
                <p>{health.agentWarning}</p>
              )}
            </div>
          </div>
        )}

        <Field id="url" label="App URL">
          <input
            id="url"
            type="url"
            required
            autoFocus={!DEMO}
            className={`${inputCls} h-12 font-mono text-[15px] shadow-sm`}
            placeholder="https://your-app.example.com"
            value={form.url}
            onChange={(e) => set({ url: e.target.value })}
          />
        </Field>

        <fieldset>
          <legend className="text-[13px] font-medium">What to test</legend>
          <div
            className="mt-1.5 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel"
            role="radiogroup"
            aria-label="What to test"
          >
            {MODES.map((m) => {
              const on = form.mode === m.id;
              return (
                <button
                  type="button"
                  key={m.id}
                  role="radio"
                  aria-checked={on}
                  onClick={() => set({ mode: m.id })}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-user ${on ? 'bg-user/[0.06]' : 'hover:bg-subtle'}`}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${on ? 'border-user' : 'border-line-strong'}`}
                  >
                    {on && <span className="size-2 rounded-full bg-user" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium">{m.title}</span>
                    <span className="block text-[13px] text-muted">{m.text}</span>
                  </span>
                  <span
                    className={`mt-0.5 shrink-0 text-[12px] ${m.ai === 'No AI' ? 'text-faint' : 'text-ai'}`}
                  >
                    {m.ai}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {form.mode === 'explore' && (
          <Field
            id="desc"
            label="What is this app?"
            hint="Optional, but the plan is much better with it."
          >
            <textarea
              id="desc"
              className={`${inputCls} min-h-[84px]`}
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
                className={`${inputCls} min-h-[84px]`}
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

        <div className="rounded-xl border border-line bg-panel">
          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
            className="flex w-full items-center gap-3 px-4 py-3 text-left text-[13px]"
          >
            <span className="font-medium">Run settings</span>
            <span className="min-w-0 flex-1 truncate text-muted">{settingsSummary(form)}</span>
            <ChevronDown
              size={15}
              className={`shrink-0 text-faint transition-transform ${advanced ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>
          {advanced && (
            <div className="space-y-5 border-t border-line px-4 py-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="conc" label="Tests in parallel">
                  <Select
                    id="conc"
                    label="Tests in parallel"
                    value={form.concurrency}
                    onValueChange={(v) => set({ concurrency: Number(v) })}
                    options={[1, 2, 3, 4]
                      .filter((n) => !health?.shared || n <= health.shared.concurrency)
                      .map((n) => ({ value: n, label: String(n) }))}
                  />
                </Field>
                <Field id="max" label="Planned tests">
                  <Select
                    id="max"
                    label="Planned tests"
                    value={form.maxTests}
                    onValueChange={(v) => set({ maxTests: Number(v) })}
                    options={[2, 3, 4, 5, 6, 8]
                      .filter((n) => !health?.shared || n <= health.shared.maxTests)
                      .map((n) => ({ value: n, label: `Up to ${n}` }))}
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
              <Field
                id="themefrom"
                label="Compare the theme with another product (optional)"
                hint="Every colour, radius and font is checked against that product's themes instead of this app's own: are all your products on one theme?"
              >
                <input
                  id="themefrom"
                  type="url"
                  className={`${inputCls} font-mono text-[13px]`}
                  placeholder="https://design.your-company.com"
                  value={form.themeFrom}
                  onChange={(e) => set({ themeFrom: e.target.value })}
                />
              </Field>
              <Field
                id="preset"
                label="Models"
                hint="The browser agent makes many calls per test, the planner and judge only a few: strong models go where calls are few."
              >
                <Select
                  id="preset"
                  label="Models"
                  value={form.preset}
                  onValueChange={(v) => set({ preset: v })}
                  options={[
                    {
                      value: 'env',
                      label: 'From .env',
                      hint: health
                        ? `agent ${short(health.model)} · planner ${short(health.plannerModel)} · judge ${short(health.judgeModel)}`
                        : 'AIE2E_MODEL, AIE2E_PLANNER_MODEL, AIE2E_JUDGE_MODEL',
                    },
                    ...['economy', 'balanced', 'best'].map((id) => ({
                      value: id,
                      label: id[0].toUpperCase() + id.slice(1),
                      hint: health?.presets?.[id]
                        ? `agent ${short(health.presets[id].model)} · planner ${short(health.presets[id].plannerModel)} · judge ${short(health.presets[id].judgeModel)}`
                        : '',
                    })),
                  ]}
                />
              </Field>
              <Field
                id="engine"
                label="Browser agent"
                hint="Who drives the browser when a test has no recording or a replay breaks."
              >
                <Select
                  id="engine"
                  label="Browser agent"
                  value={form.agentEngine}
                  onValueChange={(v) => set({ agentEngine: v })}
                  options={[
                    {
                      value: 'env',
                      label: 'From .env',
                      hint: health?.agentEngine === 'loop' ? 'Own loop' : 'Stagehand',
                    },
                    {
                      value: 'stagehand',
                      label: 'Stagehand',
                      hint: 'Stagehand 3.7.3 agent, models up to the 4.x family',
                    },
                    {
                      value: 'loop',
                      label: 'Own loop (experimental)',
                      hint: 'AI SDK tool loop on the page’s accessibility tree; any model',
                    },
                  ]}
                />
              </Field>
              <Field id="visual" label="Visual comparison">
                <Select
                  id="visual"
                  label="Visual comparison"
                  value={form.visual}
                  onValueChange={(v) => set({ visual: v })}
                  options={[
                    {
                      value: 'warn',
                      label: 'Warn',
                      hint: 'Show screenshots that differ from the approved ones',
                    },
                    {
                      value: 'fail',
                      label: 'Fail',
                      hint: 'A screenshot that differs fails the test',
                    },
                    { value: 'off', label: 'Off', hint: 'No screenshot comparison' },
                  ]}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="login"
                  label="Log in first (optional)"
                  hint={`Login page. Username and password come from AIE2E_USERNAME and AIE2E_PASSWORD in .env${health && !health.loginCreds ? ' (not set yet)' : ''}.`}
                >
                  <input
                    id="login"
                    className={`${inputCls} font-mono text-[13px]`}
                    placeholder="/login"
                    value={form.loginUrl}
                    onChange={(e) => set({ loginUrl: e.target.value })}
                  />
                </Field>
                <Field
                  id="loginok"
                  label="Text that shows the login worked"
                  hint="Optional. Default: the password field is gone."
                >
                  <input
                    id="loginok"
                    className={inputCls}
                    placeholder="e.g. Welcome back"
                    value={form.loginSuccess}
                    onChange={(e) => set({ loginSuccess: e.target.value })}
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
            className="h-11 px-6 text-[14px]"
          >
            <Play size={15} aria-hidden /> Start testing
          </Button>
          <span className="text-[12px] text-muted">
            One run at a time. Each test gets its own browser.
          </span>
        </div>
      </div>

      <aside
        className="min-w-0 space-y-8 lg:sticky lg:top-6 lg:self-start"
        aria-label="What happens"
      >
        <section>
          <h2 className="text-[15px] font-semibold">What happens when you start</h2>
          <p className="mt-0.5 text-[13px] text-muted">Updates as you fill in the form.</p>
          <ol className="relative mt-4">
            {steps.map((st, k) => {
              const a = ACTORS[st.actor];
              const last = k === steps.length - 1;
              return (
                <li key={`${st.who}-${k}`} className="relative flex gap-3 pb-5 last:pb-0">
                  {!last && (
                    <span
                      aria-hidden
                      className="absolute bottom-0 left-[15px] top-8 w-px bg-line"
                    />
                  )}
                  <span
                    className={`relative grid size-8 shrink-0 place-items-center rounded-full border ${a.ring} ${a.bg}`}
                  >
                    <a.Icon size={15} className={a.tone} aria-hidden />
                  </span>
                  <div className="min-w-0 pt-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`text-[13px] font-semibold ${a.tone}`}>{st.who}</span>
                      {st.model && <span className="text-[12px] text-faint">{st.model}</span>}
                    </div>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{st.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
        <RecentRuns />
      </aside>
    </form>
  );
}

/** The last few finished runs, so a returning person can jump back in. */
function RecentRuns() {
  const [runs, setRuns] = useState(/** @type {any[] | null} */ (null));
  useEffect(() => {
    let live = true;
    api
      .runs()
      .then((all) => live && setRuns(all.filter((r) => r.status === 'done').slice(0, 4)))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, []);
  if (!runs?.length) return null;
  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold">Recent runs</h2>
        <a href="#/runs" className="text-[13px] font-medium text-user hover:underline">
          See all
        </a>
      </div>
      <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-panel">
        {runs.map((r) => {
          const s = r.summary;
          const ok = s && s.failed + s.errored === 0;
          return (
            <li key={r.runId}>
              <a
                href={`#/runs/${r.runId}`}
                className="flex items-start gap-3 px-4 py-3 hover:bg-subtle"
              >
                <span
                  aria-hidden
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-bad'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {r.app ?? hostOf(r.targetUrl)}
                  </span>
                  <span className="block truncate text-[12px] text-muted">
                    {r.headline ?? (s ? `${s.passed} of ${s.total} passed` : 'Finished')}
                    {r.username ? `, as ${r.username}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-[12px] text-faint">{ago(r.startedAt)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "3 h ago", "2 d ago". @param {string} iso */
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(m, 1)} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
