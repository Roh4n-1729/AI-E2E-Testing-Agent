import {
  AlertTriangle,
  Bot,
  Check,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Minus,
  MonitorCheck,
  Repeat,
  Wrench,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { fileUrl } from '../api.js';
import {
  MODE,
  STATUS,
  checkKind,
  describeExpectation,
  fmtBytes,
  fmtDuration,
  fmtTokens,
  pathOf,
  shortUrl,
} from '../lib/format.js';
import { EvidenceGallery, Shot } from './Evidence.jsx';
import { Badge, Button, SectionTitle, Tab, TabList, TabPanel, Tabs } from './ui.jsx';

const SOURCE_DOT = { agent: 'bg-ai', replay: 'bg-user', harness: 'bg-faint' };

/** Everything known about one finished test, built only from the report. */
export function TestDetail({ result, runId }) {
  const { test, verdict, evidence } = result;
  const theme = evidence.theme;
  // theme screenshots and finding crops join the same viewer
  const shots = [
    ...(evidence.screenshots ?? []),
    ...(theme?.themes ?? []).flatMap((t) => [
      ...(t.screenshot
        ? [
            {
              path: t.screenshot,
              label: `theme:${t.id}`,
              source: 'harness',
              url: evidence.finalUrl,
            },
          ]
        : []),
      ...t.findings
        .filter((f) => f.crop)
        .map((f) => ({
          path: f.crop,
          label: `crop:${t.id}: ${f.category} ${f.value} (${f.kind})`,
          source: 'harness',
          url: evidence.finalUrl,
        })),
    ]),
  ];
  const themeIssues = (theme?.themes ?? []).reduce(
    (n, t) => n + t.findings.length + t.leaks.length,
    0,
  );
  const final =
    [...shots].reverse().find((s) => s.label === 'final') ?? (evidence.screenshots ?? []).at(-1);
  const api = (evidence.requests ?? []).filter((r) => r.api);
  const quality = verdict.checks.filter(
    (c) => c.advisory || ['web-vitals', 'no-a11y-violations'].includes(c.expectation.kind),
  );
  const qualityIssues = quality.filter((c) => !c.passed).length;
  const tokens = (result.llmUsage?.inputTokens ?? 0) + (result.llmUsage?.outputTokens ?? 0);
  const status = STATUS[verdict.status] ?? STATUS.error;
  const mode = MODE[result.mode] ?? MODE.agent;

  return (
    <EvidenceGallery runId={runId} shots={shots}>
      <div className="space-y-5">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            <Badge tone={mode.tone} title={mode.hint}>
              {mode.label}
            </Badge>
            {result.claimMismatch && (
              <Badge
                tone="bad"
                title="The agent's own report disagrees with the independent evidence"
              >
                Agent claim ≠ evidence
              </Badge>
            )}
            {result.heals.length > 0 && (
              <Badge tone="warn">
                <Wrench size={11} aria-hidden /> {result.heals.length} heal
                {result.heals.length > 1 ? 's' : ''}
              </Badge>
            )}
            <span className="ml-auto flex items-center gap-3 font-mono text-[12px] text-muted">
              <span>{fmtDuration(result.durationMs)}</span>
              {tokens > 0 && <span>{fmtTokens(tokens)} tokens</span>}
            </span>
          </div>
          <h2 className="text-[20px] font-semibold leading-tight tracking-tight">{test.title}</h2>
          {test.goal && <p className="max-w-3xl text-[13px] text-muted">{test.goal}</p>}
        </header>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Verdict verdict={verdict} />
          {final && (
            <figure className="space-y-1.5">
              <Shot
                runId={runId}
                path={final.path}
                alt="Final state the judge looked at"
                className="aspect-[16/10] w-full"
                highlight
              />
              <figcaption className="text-[12px] text-muted">
                Final state the judge looked at ·{' '}
                <span className="font-mono">{shortUrl(evidence.finalUrl)}</span>
              </figcaption>
            </figure>
          )}
        </div>

        <Tabs defaultValue="steps">
          <TabList>
            <Tab
              value="steps"
              count={result.trace?.filter((t) => !t.observe).length ?? shots.length}
            >
              Steps
            </Tab>
            <Tab value="checks" count={verdict.checks.length}>
              Checks
            </Tab>
            <Tab value="network" count={api.length}>
              Network
            </Tab>
            {theme?.themes?.length > 0 && (
              <Tab value="theme" count={themeIssues || undefined}>
                Theme
              </Tab>
            )}
            <Tab value="quality" count={qualityIssues || undefined}>
              Quality
            </Tab>
            {(result.agentClaim || result.heals.length > 0) && <Tab value="agent">Agent</Tab>}
          </TabList>
          <TabPanel value="steps" className="pt-4">
            <Steps result={result} runId={runId} />
          </TabPanel>
          <TabPanel value="checks" className="pt-4">
            <Checks checks={verdict.checks} />
          </TabPanel>
          <TabPanel value="network" className="pt-4">
            <Network evidence={evidence} runId={runId} />
          </TabPanel>
          <TabPanel value="theme" className="pt-4">
            {theme && <ThemePanel theme={theme} runId={runId} />}
          </TabPanel>
          <TabPanel value="quality" className="pt-4">
            <Quality evidence={evidence} />
          </TabPanel>
          <TabPanel value="agent" className="pt-4">
            <Agent result={result} />
          </TabPanel>
        </Tabs>
      </div>
    </EvidenceGallery>
  );
}

function Verdict({ verdict }) {
  const [full, setFull] = useState(false);
  const passed = verdict.status === 'pass';
  const long = verdict.reason.length > 280;
  const hard = verdict.checks.filter((c) => !c.advisory && !c.vacuous);
  return (
    <div
      className={`rounded-xl border p-4 ${passed ? 'border-ok/25 bg-ok-bg/50' : verdict.status === 'error' ? 'border-warn/30 bg-warn-bg/60' : 'border-bad/25 bg-bad-bg/60'}`}
    >
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        {passed ? (
          <MonitorCheck size={16} className="text-ok" aria-hidden />
        ) : (
          <AlertTriangle
            size={16}
            className={verdict.status === 'error' ? 'text-warn' : 'text-bad'}
            aria-hidden
          />
        )}
        {passed
          ? `Passed on ${hard.filter((c) => c.passed).length} independent checks`
          : 'Why it did not pass'}
      </div>
      {!passed && (
        <>
          <p
            className={`mt-1.5 text-[13px] leading-relaxed ${long && !full ? 'line-clamp-4' : ''}`}
          >
            {verdict.reason}
          </p>
          {long && (
            <button
              className="mt-1 text-[12px] font-medium text-muted hover:text-text"
              onClick={() => setFull(!full)}
            >
              {full ? 'Show less' : 'Show the full reason'}
            </button>
          )}
        </>
      )}
      <ul className="mt-3 space-y-1">
        {verdict.checks
          .filter((c) => !c.advisory)
          .map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <CheckIcon check={c} />
              <span className={c.vacuous ? 'text-muted line-through decoration-faint' : ''}>
                {describeExpectation(c.expectation)}
              </span>
            </li>
          ))}
      </ul>
      {verdict.warnings.length > 0 && (
        <p className="mt-3 text-[12px] text-warn">
          {verdict.warnings.length} warning{verdict.warnings.length > 1 ? 's' : ''}: see the Checks,
          Theme and Quality tabs.
        </p>
      )}
    </div>
  );
}

function CheckIcon({ check }) {
  if (check.passed && check.vacuous)
    return <Minus size={15} className="mt-0.5 shrink-0 text-warn" aria-label="not counted" />;
  if (check.passed)
    return <Check size={15} className="mt-0.5 shrink-0 text-ok" aria-label="passed" />;
  if (check.advisory)
    return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" aria-label="warning" />;
  return <X size={15} className="mt-0.5 shrink-0 text-bad" aria-label="failed" />;
}

function Steps({ result, runId }) {
  const [showObserve, setShowObserve] = useState(false);
  const trace = result.trace ?? [];
  const shown = trace.filter((t) => showObserve || !t.observe);
  const hidden = trace.length - shown.length;
  if (!trace.length) {
    // reports from before the run log existed: show the screenshots in order
    return (
      <div className="flex flex-wrap gap-3">
        {(result.evidence.screenshots ?? []).map((s) => (
          <Shot
            key={s.path}
            runId={runId}
            path={s.path}
            alt={s.label}
            className="h-[110px] w-[176px]"
          />
        ))}
      </div>
    );
  }
  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-[12px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-ai" /> agent
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-user" /> replay
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-faint" /> harness
        </span>
        {(hidden > 0 || showObserve) && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setShowObserve(!showObserve)}
          >
            {showObserve ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
            {showObserve ? 'Hide' : `Show ${hidden}`} observation steps
          </Button>
        )}
      </div>
      <ol className="relative space-y-2 before:absolute before:bottom-3 before:left-[13px] before:top-3 before:w-px before:bg-line">
        {shown.map((t, i) => (
          <li key={t.index} className="relative flex gap-3">
            <span
              className={`relative z-10 mt-2.5 flex size-[27px] shrink-0 items-center justify-center rounded-full border bg-panel font-mono text-[11px] ${t.ok ? 'border-line text-muted' : 'border-bad/40 text-bad'}`}
            >
              {i + 1}
            </span>
            <div
              className={`flex min-w-0 flex-1 gap-3 rounded-lg border p-2.5 ${t.ok ? 'border-line bg-panel' : 'border-bad/30 bg-bad-bg/40'} ${t.observe ? 'opacity-70' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 shrink-0 rounded-full ${SOURCE_DOT[t.source]}`}
                    aria-label={t.source}
                  />
                  <span className="font-mono text-[11px] text-faint">{t.tool}</span>
                  {!t.ok && <Badge tone="bad">failed</Badge>}
                </div>
                <p className="mt-1 break-words text-[13px]">{t.description}</p>
                {t.url && (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-faint">
                    {shortUrl(t.url)}
                  </p>
                )}
              </div>
              {t.screenshot && (
                <Shot
                  runId={runId}
                  path={t.screenshot}
                  alt={t.description}
                  className="h-[68px] w-[108px]"
                />
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Checks({ checks }) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
      {checks.map((c, i) => {
        const kind = checkKind(c.expectation);
        return (
          <li key={i} className="flex gap-3 px-4 py-3">
            <CheckIcon check={c} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                {describeExpectation(c.expectation)}
                <Badge tone={kind.tone}>{kind.label}</Badge>
                {c.advisory && (
                  <Badge
                    tone="warn"
                    title="The quality gate is set to warn: shown, never changes the verdict"
                  >
                    advisory
                  </Badge>
                )}
                {c.vacuous && (
                  <Badge
                    tone="warn"
                    title="Already true on the start page, so it proves nothing about what the agent did"
                  >
                    not counted
                  </Badge>
                )}
              </div>
              <p className="mt-1 break-words text-[12px] leading-relaxed text-muted">{c.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Network({ evidence, runId }) {
  const api = (evidence.requests ?? []).filter((r) => r.api);
  const stats = evidence.requestStats;
  const max = Math.max(1, ...api.map((r) => r.durationMs ?? 0));
  const downloads = evidence.downloads ?? [];
  const seen = evidence.seenText ?? [];
  const consoleErrs = (evidence.console ?? []).filter(
    (c) => c.type === 'error' || c.type === 'pageerror',
  );
  return (
    <div className="space-y-6">
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Requests" value={stats.total} />
          <Metric label="Transferred" value={fmtBytes(stats.transferredBytes)} />
          <Metric label="API calls" value={stats.api} />
          <Metric
            label="Failed"
            value={stats.failed + (evidence.networkFailures?.length ?? 0)}
            tone={stats.failed ? 'bad' : undefined}
          />
        </div>
      )}
      <div>
        <SectionTitle aside={api.length > 40 ? 'first 40 shown' : undefined}>
          API calls
        </SectionTitle>
        {api.length === 0 ? (
          <p className="text-[13px] text-muted">The page made no fetch or XHR calls.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full text-left text-[12px]">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 font-medium">Method</th>
                  <th className="px-3 py-2 font-medium">Path</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="w-[38%] px-3 py-2 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-mono">
                {api.slice(0, 40).map((r) => {
                  const bad = (r.status ?? 0) >= 400 || r.failure;
                  return (
                    <tr key={r.seq}>
                      <td className="px-3 py-1.5">{r.method}</td>
                      <td className="max-w-[320px] truncate px-3 py-1.5" title={r.url}>
                        {pathOf(r.url)}
                      </td>
                      <td className={`px-3 py-1.5 ${bad ? 'text-bad' : 'text-ok'}`}>
                        {r.status ?? r.failure ?? '…'}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 rounded-full bg-subtle">
                            <div
                              className={`h-full rounded-full ${bad ? 'bg-bad' : (r.durationMs ?? 0) > 3000 ? 'bg-warn' : 'bg-user'}`}
                              style={{ width: `${((r.durationMs ?? 0) / max) * 100}%` }}
                            />
                          </div>
                          <span className="w-14 text-right text-muted">
                            {r.durationMs != null ? fmtDuration(r.durationMs) : ''}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {downloads.length > 0 && (
        <div>
          <SectionTitle>Downloads</SectionTitle>
          <ul className="space-y-1.5">
            {downloads.map((d, i) => (
              <li key={i} className="flex items-center gap-2 text-[13px]">
                <Download size={14} className="text-muted" aria-hidden />
                {d.savedPath ? (
                  <a className="text-user hover:underline" href={fileUrl(runId, d.savedPath)}>
                    {d.filename}
                  </a>
                ) : (
                  d.filename
                )}
                {d.bytes != null && <span className="text-muted">{fmtBytes(d.bytes)}</span>}
                {d.error && <span className="text-bad">{d.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {seen.length > 0 && (
        <div>
          <SectionTitle aside="toasts, alerts and live regions, even if they vanished">
            Messages that appeared
          </SectionTitle>
          <ul className="flex flex-wrap gap-1.5">
            {seen.slice(0, 30).map((t, i) => (
              <li key={i} className="rounded-md border border-line bg-panel px-2 py-1 text-[12px]">
                {t.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(consoleErrs.length > 0 || (evidence.networkFailures ?? []).length > 0) && (
        <div>
          <SectionTitle>Errors</SectionTitle>
          <ul className="space-y-1 font-mono text-[12px] text-bad">
            {consoleErrs.map((c, i) => (
              <li key={`c${i}`} className="break-words">
                [{c.type}] {c.text}
              </li>
            ))}
            {(evidence.networkFailures ?? []).map((n, i) => (
              <li key={`n${i}`} className="break-all">
                {n.method} {n.url} → {n.status ?? n.failure}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const VITALS = [
  ['LCP', 'Largest Contentful Paint', 'ms', 2500],
  ['INP', 'Interaction to Next Paint', 'ms', 200],
  ['CLS', 'Cumulative Layout Shift', '', 0.1],
  ['FCP', 'First Contentful Paint', 'ms', 1800],
  ['TTFB', 'Time to First Byte', 'ms', 800],
];
const RATING = {
  good: ['ok', 'Good'],
  'needs-improvement': ['warn', 'Needs work'],
  poor: ['bad', 'Poor'],
};

const KIND = {
  'hard-coded': [
    'bad',
    'Hard-coded',
    'An author CSS rule sets this value without using a theme variable',
  ],
  'browser-default': [
    'warn',
    'Browser default',
    'No author style at all: the browser default shows through',
  ],
  'off-theme': ['warn', 'Off theme', 'The value matches no token of this theme'],
};
const CAT = {
  color: 'Text colour',
  background: 'Background',
  border: 'Border',
  radius: 'Radius',
  fontSize: 'Font size',
  fontFamily: 'Font',
};
const isColor = (c) => c === 'color' || c === 'background' || c === 'border';
const Swatch = ({ value }) => (
  <span
    className="inline-block size-3.5 shrink-0 rounded-[4px] border border-line-strong align-[-2px]"
    style={{ background: value.split(' ')[0] }}
    aria-hidden
  />
);

/** Does the page use the themes its own build ships, in every theme? */
function ThemePanel({ theme, runId }) {
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-[13px] text-muted">
        {theme.tokenCount} theme variables found in the production CSS. Every visible element was
        checked in each theme: a value counts as on-theme when it equals a token (colours within the
        just-noticeable difference) or when Chrome reports that the CSS rule producing it uses{' '}
        <code className="font-mono text-[12px]">var(--…)</code>.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {theme.themes.map((t) => {
          const pct = t.score === null ? null : Math.round(t.score * 100);
          const tone =
            pct === null
              ? 'text-muted'
              : pct >= 98 && !t.leaks.length
                ? 'text-ok'
                : pct >= 90
                  ? 'text-warn'
                  : 'text-bad';
          return (
            <div key={t.id} className="flex gap-4 rounded-xl border border-line bg-panel p-4">
              {t.screenshot && (
                <Shot
                  runId={runId}
                  path={t.screenshot}
                  alt={`The page in the ${t.id} theme`}
                  className="h-[96px] w-[150px]"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[15px] font-semibold capitalize">{t.id}</span>
                  <span className="truncate text-[12px] text-muted">{t.switch}</span>
                </div>
                <div className={`mt-1 font-mono text-[26px] leading-none ${tone}`}>
                  {pct === null ? 'n/a' : `${pct}%`}
                </div>
                <div className="mt-1 text-[12px] text-muted">
                  {t.onTheme}/{t.checked} values on-theme · {t.leaks.length} leak
                  {t.leaks.length === 1 ? '' : 's'} · {t.contrastIssues} contrast issue
                  {t.contrastIssues === 1 ? '' : 's'}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {Object.entries(t.categories).map(([c, v]) => (
                    <Badge key={c} tone={v.on === v.checked ? 'neutral' : 'warn'}>
                      {CAT[c] ?? c} {v.on}/{v.checked}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {theme.themes.map(
        (t) =>
          (t.findings.length > 0 || t.leaks.length > 0) && (
            <div key={t.id}>
              <SectionTitle
                aside={`${t.findings.length} value${t.findings.length === 1 ? '' : 's'}, ${t.leaks.length} leak${t.leaks.length === 1 ? '' : 's'}`}
              >
                Off-theme in <span className="capitalize">{t.id}</span>
              </SectionTitle>
              <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
                {t.leaks.map((l, i) => (
                  <li key={`l${i}`} className="flex gap-3 px-4 py-3 text-[13px]">
                    <Badge tone="bad">Leak</Badge>
                    <div className="min-w-0 flex-1">
                      <div>
                        <Swatch value={l.value} /> <span className="font-mono">{l.value}</span>{' '}
                        stays the same in every theme
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted">
                        {l.selector}
                        {l.source && ` · ${l.source}`}
                      </div>
                    </div>
                  </li>
                ))}
                {t.findings.map((f, i) => {
                  const [tone, label, hint] = KIND[f.kind] ?? KIND['off-theme'];
                  return (
                    <li key={i} className="flex gap-3 px-4 py-3 text-[13px]">
                      {f.crop ? (
                        <Shot
                          runId={runId}
                          path={f.crop}
                          alt={`${f.category} ${f.value}`}
                          className="h-[48px] w-[72px]"
                        />
                      ) : (
                        <span className="h-[48px] w-[72px] shrink-0 rounded-lg border border-dashed border-line" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={tone} title={hint}>
                            {label}
                          </Badge>
                          <span className="text-muted">{CAT[f.category] ?? f.category}</span>
                          {isColor(f.category) && <Swatch value={f.value} />}
                          <span className="font-mono">{f.value}</span>
                          <span className="text-muted">× {f.count}</span>
                          {f.nearest?.token && (
                            <span className="text-[12px] text-muted">
                              nearest {isColor(f.category) && <Swatch value={f.nearest.value} />}{' '}
                              <span className="font-mono">{f.nearest.token}</span> {f.nearest.value}
                              {f.nearest.deltaE != null && ` · ΔE ${f.nearest.deltaE}`}
                            </span>
                          )}
                        </div>
                        {f.declaration && (
                          <div
                            className="mt-1 truncate font-mono text-[11px] text-muted"
                            title={f.declaration.value}
                          >
                            {f.declaration.selector
                              ? `${f.declaration.selector} { ${f.declaration.value} }`
                              : f.declaration.value}
                            {f.declaration.source && ` · ${f.declaration.source}`}
                          </div>
                        )}
                        <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
                          {f.examples.map((e) => e.selector).join(' · ')}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ),
      )}
    </div>
  );
}

function Quality({ evidence }) {
  const worst = useMemo(() => {
    const m = new Map();
    for (const doc of evidence.vitals ?? [])
      for (const v of doc.metrics)
        if (!m.has(v.name) || v.value > m.get(v.name).value) m.set(v.name, v);
    return m;
  }, [evidence.vitals]);
  const a11y = evidence.a11y;
  return (
    <div className="space-y-6">
      <div>
        <SectionTitle aside="worst value across the pages this test loaded">
          Core Web Vitals
        </SectionTitle>
        {worst.size === 0 ? (
          <p className="text-[13px] text-muted">Nothing measurable on this page.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {VITALS.filter(([k]) => worst.has(k)).map(([k, name, unit, good]) => {
              const v = worst.get(k);
              const [tone, label] = RATING[v.rating] ?? ['neutral', v.rating];
              return (
                <div key={k} className="rounded-xl border border-line bg-panel p-3" title={name}>
                  <div className="flex items-center justify-between text-[12px] text-muted">
                    {k} <Badge tone={tone}>{label}</Badge>
                  </div>
                  <div className="mt-1 font-mono text-[20px]">
                    {unit ? fmtDuration(v.value) : v.value.toFixed(3)}
                  </div>
                  <div className="text-[11px] text-faint">good ≤ {unit ? `${good}ms` : good}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div>
        <SectionTitle aside="axe-core · WCAG 2.1 A and AA">Accessibility</SectionTitle>
        {!a11y ? (
          <p className="text-[13px] text-muted">Not scanned (quality gate off).</p>
        ) : a11y.error ? (
          <p className="text-[13px] text-muted">The scan could not run: {a11y.error}</p>
        ) : a11y.violations.length === 0 ? (
          <p className="text-[13px] text-ok">No violations found.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
            {a11y.violations.map((v) => (
              <li key={v.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Badge tone={v.impact === 'critical' || v.impact === 'serious' ? 'bad' : 'warn'}>
                    {v.impact ?? 'minor'}
                  </Badge>
                  <span className="font-medium">{v.help}</span>
                  <a
                    className="inline-flex items-center gap-1 font-mono text-[12px] text-user hover:underline"
                    href={v.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {v.id} <ExternalLink size={11} aria-hidden />
                  </a>
                  <span className="text-[12px] text-muted">
                    {v.nodes} element{v.nodes === 1 ? '' : 's'}
                  </span>
                </div>
                {v.examples?.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {v.examples.map((x, i) => (
                      <li
                        key={i}
                        className="truncate font-mono text-[11px] text-muted"
                        title={x.html}
                      >
                        {x.target}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Agent({ result }) {
  return (
    <div className="space-y-6">
      {result.agentClaim && (
        <div>
          <SectionTitle aside="recorded for comparison, never used for the verdict">
            What the agent said
          </SectionTitle>
          <div
            className={`rounded-xl border p-4 text-[13px] leading-relaxed ${result.claimMismatch ? 'border-bad/30 bg-bad-bg/40' : 'border-line bg-panel'}`}
          >
            <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
              <Bot size={14} className="text-ai" aria-hidden />
              Claimed {result.agentClaim.success ? 'success' : 'failure'}
              {result.claimMismatch && <Badge tone="bad">disagrees with the evidence</Badge>}
            </div>
            <p className="whitespace-pre-wrap text-muted">{result.agentClaim.message}</p>
          </div>
        </div>
      )}
      {result.heals.length > 0 && (
        <div>
          <SectionTitle>Self-healing</SectionTitle>
          <ul className="space-y-2">
            {result.heals.map((h, i) => (
              <li
                key={i}
                className="rounded-xl border border-warn/30 bg-warn-bg/50 p-3 text-[13px]"
              >
                <div className="flex items-center gap-2 font-medium">
                  <Repeat size={14} aria-hidden /> Step {h.stepIndex}: {h.description}
                  <Badge tone={h.outcome === 'healed' ? 'ok' : 'bad'}>{h.outcome}</Badge>
                </div>
                <p className="mt-1 text-[12px] text-muted">{h.reason}</p>
                {(h.oldSelector || h.newSelector) && (
                  <div className="mt-2 space-y-0.5 break-all font-mono text-[11px]">
                    {h.oldSelector && <div className="text-bad">− {h.oldSelector}</div>}
                    {h.newSelector && <div className="text-ok">+ {h.newSelector}</div>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(result.mode === 'agent' || result.mode === 'healed') &&
        result.verdict.status === 'pass' && (
          <a
            className="inline-flex items-center gap-1.5 text-[13px] text-user hover:underline"
            href={`#/recordings/${result.test.id}`}
          >
            <Repeat size={13} aria-hidden /> Open the recording saved for replay
          </a>
        )}
    </div>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={`mt-0.5 font-mono text-[18px] ${tone === 'bad' ? 'text-bad' : ''}`}>
        {value}
      </div>
    </div>
  );
}
