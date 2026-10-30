import { escapeHtml as h } from '../util/misc.js';

/**
 * @import { Reporter } from '../core/ports.js'
 * @import { CheckResult, Expectation, RunReport, TestResult } from '../core/types.js'
 * @import { RunArtifacts } from '../storage/artifacts.js'
 * @import { Logger } from '../util/logger.js'
 */

/*
 * One self-contained file you can email or attach to a PR: same design tokens as the web UI,
 * light/dark (follows the system, with a toggle), a step timeline with the screenshot after every
 * step, and a keyboard-driven image viewer instead of links that open new tabs. No external assets.
 */

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--subtle:#f0f2f5;--text:#14161b;--muted:#5d6472;--faint:#8d94a3;--line:#e2e5ea;--line2:#cfd4dc;--user:#4250d5;--ai:#d9612a;--ok:#157a4c;--okbg:#e6f4ec;--warn:#9a6408;--warnbg:#fbf0dc;--bad:#c2303b;--badbg:#fbe9ea;color-scheme:light}
:root.dark{--bg:#0d121c;--panel:#141b28;--subtle:#1a2232;--text:#e7eaf0;--muted:#9aa3b5;--faint:#6c7589;--line:#243046;--line2:#33415c;--user:#8f9bff;--ai:#f0874f;--ok:#4cc58a;--okbg:#12301f;--warn:#e5b45a;--warnbg:#33270f;--bad:#ff7a83;--badbg:#3a161c;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:1180px;margin:0 auto;padding:28px 20px 80px}
header.top{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
h1{font-size:22px;letter-spacing:-.01em;margin:0;word-break:break-all}h2{font-size:17px;margin:0;letter-spacing:-.01em}h3{font-size:13px;margin:22px 0 8px}
.muted{color:var(--muted)}.faint{color:var(--faint)}.small{font-size:12px}
.toggle{margin-left:auto;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer}
.summary{margin:20px 0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.nums{display:flex;flex-wrap:wrap;gap:12px 32px;align-items:flex-end}.nums b{display:block;font:500 18px/1 'Geist Mono',ui-monospace,monospace}.nums .big b{font:600 28px/1 Geist,system-ui,sans-serif}.nums span{font-size:12px;color:var(--muted)}
.bar{display:flex;height:6px;border-radius:99px;overflow:hidden;background:var(--subtle);margin-top:16px}.bar i{display:block}
.test{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:12px 0}
.test>summary{cursor:pointer;padding:14px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;list-style:none}.test>summary::-webkit-details-marker{display:none}
.test[open]>summary{border-bottom:1px solid var(--line)}
.body{padding:4px 16px 18px}
.dot{width:8px;height:8px;border-radius:99px;flex:none}
.badge{font-size:11px;font-weight:500;border-radius:6px;padding:1px 6px;border:1px solid var(--line);background:var(--subtle);color:var(--muted);white-space:nowrap}
.b-ok{background:var(--okbg);color:var(--ok);border-color:transparent}.b-bad{background:var(--badbg);color:var(--bad);border-color:transparent}.b-warn{background:var(--warnbg);color:var(--warn);border-color:transparent}.b-ai{color:var(--ai)}.b-user{color:var(--user)}
.title{font-weight:600;flex:1;min-width:220px}
.verdict{border-radius:10px;padding:12px 14px;margin-top:14px;border:1px solid var(--line)}.v-pass{background:var(--okbg)}.v-fail{background:var(--badbg)}.v-error{background:var(--warnbg)}
.checks{list-style:none;padding:0;margin:8px 0 0}.checks li{display:flex;gap:8px;padding:3px 0}.checks .d{color:var(--muted);font-size:12px}
.ic{width:16px;flex:none;font-weight:700}.pass{color:var(--ok)}.fail{color:var(--bad)}.warn{color:var(--warn)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px}@media(max-width:860px){.grid{grid-template-columns:1fr}}
.thumb{display:block;padding:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--subtle);cursor:zoom-in}
.thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
.steps{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.step{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:10px}
.step.bad{border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:var(--badbg)}.step.obs{opacity:.65}
.num{width:24px;height:24px;border-radius:99px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font:11px 'Geist Mono',monospace;color:var(--muted);flex:none}
.step .t{width:116px;height:72px;flex:none;margin-left:auto}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}td.u{word-break:break-all}
.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{border:1px solid var(--line);border-radius:8px;padding:6px 10px}.chip b{display:block;font:500 16px 'Geist Mono',monospace}
pre{white-space:pre-wrap;word-break:break-word;margin:0;background:var(--subtle);border-radius:8px;padding:10px;font-size:12px}
a{color:var(--user)}
dialog{border:0;padding:0;background:rgb(8 11 18 / .95);color:#fff;max-width:none;max-height:none;width:100vw;height:100vh}
dialog::backdrop{background:rgb(8 11 18 / .9)}
.lb{display:flex;flex-direction:column;height:100%}.lb header{display:flex;gap:12px;align-items:center;padding:12px 16px;font-size:13px}
.lb .stage{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:0 56px}.lb img{max-width:100%;max-height:100%;border-radius:6px}
.lb button{background:rgb(255 255 255 / .1);color:#fff;border:0;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer}.lb .nav{position:absolute;top:50%;transform:translateY(-50%)}
@media print{.toggle,dialog{display:none}.test{break-inside:avoid}}
`;

/** Tiny viewer: every .thumb opens a full-screen view of all screenshots of its test; arrows/Esc. */
const SCRIPT = `
(() => {
  const root = document.documentElement;
  const saved = localStorage.getItem('aie2e:theme');
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.classList.toggle('dark', dark);
  document.querySelector('.toggle')?.addEventListener('click', () => {
    const d = !root.classList.contains('dark'); root.classList.toggle('dark', d);
    try { localStorage.setItem('aie2e:theme', d ? 'dark' : 'light'); } catch (_) {}
  });
  const dlg = document.getElementById('lb'); const img = dlg.querySelector('img'); const cap = dlg.querySelector('.cap');
  let list = [], i = 0;
  const show = () => { const t = list[i]; img.src = t.dataset.src; img.alt = t.dataset.caption; cap.textContent = (i + 1) + ' / ' + list.length + '  ' + t.dataset.caption; };
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.thumb'); if (!t) return;
    list = [...document.querySelectorAll('.thumb[data-group="' + t.dataset.group + '"]')].filter((x, k, a) => a.findIndex((y) => y.dataset.src === x.dataset.src) === k);
    i = Math.max(0, list.findIndex((x) => x.dataset.src === t.dataset.src)); show(); dlg.showModal();
  });
  dlg.querySelector('.prev').onclick = () => { i = (i - 1 + list.length) % list.length; show(); };
  dlg.querySelector('.next').onclick = () => { i = (i + 1) % list.length; show(); };
  dlg.querySelector('.close').onclick = () => dlg.close();
  dlg.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') dlg.querySelector('.prev').click(); if (e.key === 'ArrowRight') dlg.querySelector('.next').click(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.classList.contains('stage')) dlg.close(); });
})();`;

const STATUS = {
  pass: ['Passed', 'b-ok', 'var(--ok)'],
  fail: ['Failed', 'b-bad', 'var(--bad)'],
  error: ['Error', 'b-warn', 'var(--warn)'],
};
const MODE = {
  agent: ['Agent', 'b-ai'],
  replay: ['Replay', 'b-user'],
  healed: ['Healed', 'b-warn'],
  deterministic: ['Scripted', ''],
};

/** @param {number} ms */
const dur = (ms) =>
  ms < 1000
    ? `${ms}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
/** @param {number} n */
const tok = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** @param {Expectation} e */
function describe(e) {
  switch (e.kind) {
    case 'url':
      return `URL ${e.mode === 'regex' ? 'matches' : 'contains'} ${e.pattern}`;
    case 'text-visible':
      return `"${e.text}" is visible`;
    case 'selector-visible':
      return `${e.selector} is visible`;
    case 'visual':
      return e.question;
    case 'api-call':
      return `API ${e.method ?? 'call'} ${e.urlPattern}`;
    case 'download':
      return e.filenamePattern
        ? `A ${e.filenamePattern} file is downloaded`
        : 'A file is downloaded';
    case 'text-appeared':
      return `"${e.text}" appears, even briefly`;
    case 'web-vitals':
      return 'Core Web Vitals within budget';
    case 'theme-conformance':
      return `Uses the app's own theme in every theme (≥ ${Math.round(e.minScore * 100)}% on-theme)`;
    case 'no-a11y-violations':
      return `No ${e.minImpact} or worse accessibility issues`;
    case 'no-console-errors':
      return 'No console errors';
    case 'no-network-failures':
      return 'No failed network requests';
  }
}

/** @param {CheckResult} c */
function checkRow(c) {
  const [ic, cls, word] = c.passed
    ? c.vacuous
      ? ['–', 'warn', 'NOT COUNTED']
      : ['✓', 'pass', 'PASS']
    : c.advisory
      ? ['!', 'warn', 'WARN']
      : ['✕', 'fail', 'FAIL'];
  return `<li><span class="ic ${cls}" title="${word}">${ic}</span><span><span>${h(describe(c.expectation))}</span>${c.advisory ? ' <span class="badge b-warn">advisory</span>' : ''}${c.vacuous ? ' <span class="badge b-warn">not counted as evidence</span>' : ''}<br><span class="d">${h(c.detail)}</span></span></li>`;
}

/** @param {string} group @param {string} src @param {string} caption @param {string} [style] */
const thumb = (group, src, caption, style = '') =>
  `<button class="thumb" style="${style}" data-group="${h(group)}" data-src="${h(src)}" data-caption="${h(caption)}"><img loading="lazy" src="${h(src)}" alt="${h(caption)}"></button>`;

/** Theme conformance: score per theme, leaks, and off-theme values with the CSS rule that set them. @param {TestResult} r @param {string} g */
function renderTheme(r, g) {
  const states = r.evidence.themeStates?.length
    ? r.evidence.themeStates
    : r.evidence.theme
      ? [
          {
            label: 'final',
            url: r.evidence.finalUrl,
            audit: r.evidence.theme,
            reusedFrom: undefined,
          },
        ]
      : [];
  const audited = states.filter((st) => st.audit.themes.length);
  if (!audited.length) return '';
  const blocks = audited.map((st) => {
    const t = st.audit;
    const cards = t.themes
      .map((th) => {
        const pct = th.score === null ? 'n/a' : `${Math.round(th.score * 100)}%`;
        const cls =
          th.score === null
            ? ''
            : th.score >= 0.98 && !th.leaks.length
              ? 'pass'
              : th.score >= 0.9
                ? 'warn'
                : 'fail';
        return `<div class="chip" style="display:flex;gap:10px;align-items:center">${th.screenshot ? thumb(g, th.screenshot, `${st.label} · theme ${th.id}`, 'width:96px;height:60px') : ''}<div><span class="small muted">${h(th.id)} · ${h(th.switch)}</span><b class="${cls}">${pct}</b><span class="small muted">${th.onTheme}/${th.checked} on-theme · ${th.leaks.length} leaks · ${th.contrastIssues} contrast</span></div></div>`;
      })
      .join('');
    const rows = t.themes
      .flatMap((th) => [
        ...th.leaks.map(
          (l) =>
            `<tr><td>${h(th.id)}</td><td><span class="badge b-bad">leak</span></td><td class="mono">${h(l.value)}</td><td class="u mono">${h(l.selector)}${l.source ? ` · ${h(l.source)}` : ''}</td></tr>`,
        ),
        ...th.findings.map(
          (f) =>
            `<tr><td>${h(th.id)}</td><td><span class="badge ${f.kind === 'hard-coded' ? 'b-bad' : 'b-warn'}">${h(f.kind)}</span> ${h(f.category)}</td><td class="mono">${h(f.value)} ×${f.count}${f.nearest?.token ? `<br><span class="faint">nearest ${h(f.nearest.token)} ${h(f.nearest.value)}${f.nearest.deltaE != null ? ` ΔE ${f.nearest.deltaE}` : ''}</span>` : ''}</td><td class="u mono">${f.declaration ? `${h(f.declaration.selector ?? '')} { ${h(f.declaration.value)} }${f.declaration.source ? ` · ${h(f.declaration.source)}` : ''}` : h(f.examples[0]?.selector ?? '')}</td></tr>`,
        ),
      ])
      .join('');
    const head =
      audited.length > 1
        ? `<p class="small" style="margin:14px 0 6px"><b>${h(st.label)}</b> <span class="mono faint">${h(route(st.url))}</span>${st.reusedFrom ? ` <span class="faint">· audited in ${h(st.reusedFrom.testId)} (${h(st.reusedFrom.label)})</span>` : ''}</p>`
        : '';
    return `${head}<div class="chips">${cards}</div>${rows ? `<table style="margin-top:10px"><tr><th>Theme</th><th>Problem</th><th>Value</th><th>Where</th></tr>${rows}</table>` : ''}`;
  });
  const tokens = audited[0]?.audit.tokenCount ?? 0;
  const ref = audited[0]?.audit.reference;
  return `<h3>Theme conformance ${ref ? `against <a href="${h(ref)}">${h(ref)}</a> (${tokens} reference tokens` : `(${tokens} theme variables`} · ${audited.length} screen${audited.length === 1 ? '' : 's'})</h3>${blocks.join('')}`;
}

/**
 * Screenshots vs approved baselines: changed ones first, with baseline / this run / difference.
 * @param {TestResult} r @param {string} g
 */
function renderVisual(r, g) {
  const res = r.evidence.visual?.results ?? [];
  if (!res.length) return '';
  const order = { changed: 0, size: 0, error: 1, new: 2, unchanged: 3 };
  const label = {
    changed: ['b-bad', 'changed'],
    size: ['b-bad', 'size changed'],
    new: ['', 'new baseline'],
    unchanged: ['b-ok', 'matches'],
    error: ['b-warn', 'not compared'],
  };
  const pct = (/** @type {number | undefined} */ x) =>
    x === undefined ? '' : `${x >= 0.1 ? (x * 100).toFixed(0) : (x * 100).toFixed(2)}%`;
  const rows = [...res]
    .sort((a, b) => order[a.status] - order[b.status])
    .map((v) => {
      const [cls, txt] = label[v.status];
      const imgs =
        v.status === 'unchanged'
          ? ''
          : `<div class="chips" style="margin-top:6px">${[
              ['baseline', v.baseline],
              ['this run', v.current],
              ['difference', v.diff],
            ]
              .filter(([, p]) => p)
              .map(
                ([c, p]) =>
                  `<div>${thumb(g, /** @type {string} */ (p), `${v.label}: ${c}`, 'width:180px;height:112px')}<div class="small faint">${c}</div></div>`,
              )
              .join('')}</div>`;
      return `<li style="margin-bottom:8px"><b>${h(v.label)}</b> <span class="badge ${cls}">${txt}</span>${v.diffRatio !== undefined && v.status !== 'unchanged' ? ` <span class="small mono muted">${pct(v.diffRatio)} of pixels</span>` : ''}${v.saved ? ' <span class="small pass">saved as the baseline</span>' : ''}${v.note ? ` <span class="small muted">${h(v.note)}</span>` : ''}${imgs}</li>`;
    })
    .join('');
  return `<h3>Visual comparison (${res.length} screenshot${res.length === 1 ? '' : 's'})</h3><ul style="list-style:none;padding:0">${rows}</ul>`;
}

/** @param {string} url */
function route(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.hash.startsWith('#/') ? u.hash : ''}`;
  } catch {
    return url;
  }
}

/**
 * Run-level: the same kinds of element compared across every audited screen. Advisory.
 * @param {RunReport} report
 */
function renderConsistency(report) {
  const c = report.consistency;
  if (!c || !c.states) return '';
  const style = (/** @type {Record<string, string>} */ st) =>
    Object.entries(st)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
  const rows = c.findings
    .map(
      (f) =>
        `<tr><td>${h(f.theme)}</td><td><span class="badge b-warn">${f.type === 'near-duplicate' ? 'near-duplicate' : 'component varies'}</span> ${h(f.component ? `${f.component} (${f.kind})` : f.kind)}</td><td class="mono">${f.diffs.map((d) => `${h(d.prop)}: ${h(d.a)} vs ${h(d.b)}${d.deltaE !== undefined ? ` <span class="faint">ΔE ${d.deltaE}</span>` : ''}`).join('<br>')}</td><td class="u mono">${f.styles.map((s) => `${h(s.pages.join(', '))} · ${h(s.example.selector)}${s.example.text ? ` "${h(s.example.text)}"` : ''} ×${s.count}<br><span class="faint">${h(style(s.style))}</span>`).join('<br>')}</td></tr>`,
    )
    .join('');
  return `<section class="summary"><h3 style="margin-top:0">Consistency across screens</h3>
<p class="small muted">${c.states} distinct screen${c.states === 1 ? '' : 's'} audited in ${c.themes.length} theme${c.themes.length === 1 ? '' : 's'}. Buttons, links, inputs, headings and named components (data-aie2e-component) are compared; looks that differ only slightly are probably meant to be one. Advisory: this never changes a verdict.</p>
${rows ? `<table><tr><th>Theme</th><th>Element</th><th>What differs</th><th>Where</th></tr>${rows}</table>` : '<p class="pass">No drift found: every kind of element looks the same wherever it appears.</p>'}</section>`;
}

/** @param {TestResult} r */
function renderTest(r) {
  const v = r.verdict;
  const [label, cls, color] = STATUS[v.status] ?? STATUS.error;
  const [mLabel, mCls] = MODE[r.mode] ?? ['?', ''];
  const shots = r.evidence.screenshots ?? [];
  const final = [...shots].reverse().find((s) => s.label === 'final') ?? shots[shots.length - 1];
  const g = r.test.id;

  const trace = (r.trace ?? []).filter((t) => !t.observe);
  const steps = trace.length
    ? `<ol class="steps">${trace
        .map(
          (t, i) =>
            `<li class="step${t.ok ? '' : ' bad'}"><span class="num">${i + 1}</span><div style="min-width:0;flex:1"><div class="small faint mono">${h(t.source)} · ${h(t.tool)}</div><div>${h(t.description)}</div>${t.url ? `<div class="small faint mono" style="word-break:break-all">${h(t.url)}</div>` : ''}</div>${t.screenshot ? `<span class="t">${thumb(g, t.screenshot, `Step ${i + 1}: ${t.description}`, 'width:116px;height:72px')}</span>` : ''}</li>`,
        )
        .join('')}</ol>`
    : `<div class="chips">${shots.map((s) => thumb(g, s.path, `${s.label} (${s.source})`, 'width:180px;height:112px')).join('')}</div>`;

  const api = (r.evidence.requests ?? []).filter((q) => q.api);
  const vit = new Map();
  for (const d of r.evidence.vitals ?? [])
    for (const m of d.metrics)
      if (!vit.has(m.name) || m.value > vit.get(m.name).value) vit.set(m.name, m);
  const a11y = r.evidence.a11y;
  const consoleErrs = r.evidence.console
    .map((c) => `<li>[${h(c.type)}] ${h(c.text.slice(0, 300))}</li>`)
    .join('');
  const net = r.evidence.networkFailures
    .map((n) => `<li>${h(n.method)} ${h(n.url)} → ${h(n.status ?? n.failure ?? '?')}</li>`)
    .join('');

  return `<details class="test"${v.status === 'pass' ? '' : ' open'}>
<summary><span class="dot" style="background:${color}"></span><span class="title">${h(r.test.title)}</span>
<span class="badge ${cls}">${label}</span><span class="badge ${mCls}">${mLabel}</span>
${r.heals.length ? `<span class="badge b-warn">${r.heals.length} heal(s)</span>` : ''}
${r.claimMismatch ? '<span class="badge b-bad">agent claim ≠ evidence</span>' : ''}
<span class="small muted mono">${dur(r.durationMs)}${r.llmUsage ? ` · ${tok(r.llmUsage.inputTokens + r.llmUsage.outputTokens)} tokens` : ''}</span></summary>
<div class="body">
${r.test.goal ? `<p class="muted" style="margin:12px 0 0">${h(r.test.goal)}</p>` : ''}
<div class="grid"><div>
<div class="verdict v-${v.status}"><b>${v.status === 'pass' ? 'Passed on independent evidence' : 'Why it did not pass'}</b>${v.status !== 'pass' ? `<div style="margin-top:4px">${h(v.reason)}</div>` : ''}
<ul class="checks">${v.checks.map(checkRow).join('') || '<li class="muted">no checks</li>'}</ul>
${v.warnings.length ? `<div class="small warn" style="margin-top:8px">${v.warnings.map((w) => h(w)).join('<br>')}</div>` : ''}</div>
</div>${final ? `<div style="margin-top:14px">${thumb(g, final.path, 'Final state (judged)', 'width:100%;aspect-ratio:16/10')}<div class="small muted" style="margin-top:6px">Final state the judge looked at</div></div>` : ''}</div>
<h3>Steps</h3>${steps}
${
  api.length
    ? `<h3>API calls (${api.length})</h3><table><tr><th>Method</th><th>URL</th><th>Status</th><th>Time</th></tr>${api
        .slice(0, 40)
        .map(
          (q) =>
            `<tr><td class="mono">${h(q.method)}</td><td class="u mono">${h(q.url)}</td><td class="mono ${(q.status ?? 0) >= 400 || q.failure ? 'fail' : 'pass'}">${h(q.status ?? q.failure ?? '…')}</td><td class="mono">${q.durationMs != null ? dur(q.durationMs) : ''}</td></tr>`,
        )
        .join('')}</table>`
    : ''
}
${r.evidence.requestStats ? `<p class="small muted">${r.evidence.requestStats.total} requests · ${Math.round(r.evidence.requestStats.transferredBytes / 1024)} KB transferred · ${r.evidence.requestStats.failed} failed</p>` : ''}
${renderTheme(r, g)}
${renderVisual(r, g)}
${
  vit.size
    ? `<h3>Core Web Vitals</h3><div class="chips">${['LCP', 'INP', 'CLS', 'FCP', 'TTFB']
        .filter((n) => vit.has(n))
        .map((n) => {
          const m = vit.get(n);
          const c = m.rating === 'good' ? 'pass' : m.rating === 'poor' ? 'fail' : 'warn';
          return `<div class="chip"><span class="small muted">${n}</span><b class="${c}">${n === 'CLS' ? m.value.toFixed(3) : dur(Math.round(m.value))}</b></div>`;
        })
        .join('')}</div>`
    : ''
}
${a11y ? `<h3>Accessibility (axe-core, WCAG A/AA)</h3>${a11y.error ? `<p class="muted">Scan could not run: ${h(a11y.error)}</p>` : a11y.violations.length ? `<ul>${a11y.violations.map((x) => `<li><span class="badge ${x.impact === 'critical' || x.impact === 'serious' ? 'b-bad' : 'b-warn'}">${h(x.impact ?? 'minor')}</span> ${h(x.help)} <a href="${h(x.helpUrl)}">${h(x.id)}</a> <span class="muted">(${x.nodes})</span></li>`).join('')}</ul>` : '<p class="pass">No violations found</p>'}` : ''}
${r.evidence.downloads?.length ? `<h3>Downloads</h3><ul>${r.evidence.downloads.map((d) => `<li>${d.savedPath ? `<a href="${h(d.savedPath)}">${h(d.filename)}</a>` : h(d.filename)}${d.bytes != null ? ` <span class="muted">(${d.bytes} bytes)</span>` : ''}${d.error ? ` <span class="fail">${h(d.error)}</span>` : ''}</li>`).join('')}</ul>` : ''}
${
  r.evidence.seenText?.length
    ? `<h3>Messages that appeared</h3><p class="small">${r.evidence.seenText
        .slice(0, 20)
        .map((t) => `<span class="badge">${h(t.text)}</span>`)
        .join(' ')}</p>`
    : ''
}
${r.agentClaim ? `<h3>What the agent claimed (not trusted)</h3><pre>${r.agentClaim.success ? 'Claimed success' : 'Claimed failure'}\n${h(r.agentClaim.message)}</pre>` : ''}
${r.heals.length ? `<h3>Self-healing</h3><ul>${r.heals.map((e) => `<li>Step ${e.stepIndex}: ${h(e.description)} <span class="badge ${e.outcome === 'healed' ? 'b-ok' : 'b-bad'}">${e.outcome}</span><br><span class="small muted">${h(e.reason)}</span>${e.oldSelector || e.newSelector ? `<br><span class="small mono"><span class="fail">− ${h(e.oldSelector ?? '?')}</span> <span class="pass">+ ${h(e.newSelector ?? '?')}</span></span>` : ''}</li>`).join('')}</ul>` : ''}
${consoleErrs ? `<h3>Console</h3><ul class="small mono">${consoleErrs}</ul>` : ''}
${net ? `<h3>Failed requests</h3><ul class="small mono">${net}</ul>` : ''}
<p class="small faint" style="margin-top:18px">${h(r.evidence.finalUrl)} · "${h(r.evidence.title)}"${r.evidence.ariaSnapshotPath ? ` · <a href="${h(r.evidence.ariaSnapshotPath)}">accessibility tree</a>` : ''}</p>
</div></details>`;
}

/**
 * Pure function: report in, self-contained HTML string out (screenshots are relative links,
 * so keep report.html next to its test folders).
 * @param {RunReport} report
 */
export function renderReport(report) {
  const s = report.summary;
  const over = (s.overhead?.inputTokens ?? 0) + (s.overhead?.outputTokens ?? 0);
  const pct = (/** @type {number} */ n) => `${(n / Math.max(1, s.total)) * 100}%`;
  const num = (/** @type {string} */ label, /** @type {string | number} */ n, cls = '') =>
    `<div><b class="${cls}">${n}</b><span>${label}</span></div>`;
  const ms = report.startedAt
    ? new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime()
    : NaN;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>E2E report · ${h(report.targetUrl)}</title><style>${CSS}</style></head><body><main>
<header class="top"><div style="min-width:0"><div class="small muted">AI E2E Agent report</div><h1>${h(report.targetUrl.replace(/^https?:\/\//, ''))}</h1>
<div class="small muted">Run <span class="mono">${h(report.runId)}</span> · finished ${h(report.finishedAt)}${report.auth ? ` · logged in as ${h(report.auth.username)} at ${h(report.auth.loginUrl)}` : ''}</div></div>
<button class="toggle" type="button">Light / dark</button></header>
<section class="summary"><div class="nums"><div class="big"><b>${s.passed}<span style="font-size:inherit;color:var(--faint)">/${s.total}</span></b><span>tests passed</span></div>
${num('failed', s.failed, s.failed ? 'fail' : '')}${num('errors', s.errored, s.errored ? 'warn' : '')}${num('healed', s.healed)}${s.visualChanges ? num('visual changes', s.visualChanges, 'warn') : ''}${num('claim ≠ evidence', s.claimMismatches, s.claimMismatches ? 'fail' : '')}${num('agent tokens', tok(s.inputTokens + s.outputTokens))}${over ? num('planner + judge tokens', tok(over)) : ''}${Number.isFinite(ms) ? num('duration', dur(ms)) : ''}</div>
<div class="bar"><i style="width:${pct(s.passed)};background:var(--ok)"></i><i style="width:${pct(s.failed)};background:var(--bad)"></i><i style="width:${pct(s.errored)};background:var(--warn)"></i></div></section>
${renderConsistency(report)}
${report.results.map(renderTest).join('\n')}
<p class="small faint">Pass or fail is decided only from evidence the harness collected (page, URL, network, downloads, screenshots). What the agent said is shown for comparison and never used for the verdict.</p>
</main>
<dialog id="lb" aria-label="Screenshot viewer"><div class="lb"><header><span class="cap"></span><button class="close" style="margin-left:auto">Close (Esc)</button></header>
<div class="stage" style="position:relative"><button class="nav prev" style="left:12px" aria-label="Previous">‹</button><img alt=""><button class="nav next" style="right:12px" aria-label="Next">›</button></div></div></dialog>
<script>${SCRIPT}</script></body></html>`;
}

/** @implements {Reporter} */
export class HtmlReporter {
  /** @param {RunArtifacts} artifacts @param {Logger} logger */
  constructor(artifacts, logger) {
    this.artifacts = artifacts;
    this.logger = logger;
  }

  /** @param {RunReport} report */
  async report(report) {
    const file = await this.artifacts.writeText('report.html', renderReport(report));
    this.logger.info(`HTML report: ${file}`);
  }
}
