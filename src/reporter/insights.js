/**
 * Plain-English reading of a run report, for people who are not developers: a headline, the problems
 * found (grouped, with severity), what happened in each test, and the pages each test went through.
 *
 * Pure and deterministic: no LLM, no I/O, so the web UI and report.html show exactly the same words,
 * and every sentence is traceable to a check the judge made. Nothing here changes a verdict.
 *
 * @import { CheckResult, Expectation, RunReport, TestResult, TraceEntry } from '../core/types.js'
 */
import { neededPerson, wasHelped } from '../core/humanHelp.js';
import { clip, explainError } from '../util/explain.js';

/**
 * @typedef {'high' | 'medium' | 'review' | 'low'} Severity
 *   high = a flow is blocked; medium = a flow gives a wrong result; review = needs a person's decision
 *   (visual change, AI disagreement); low = advisory quality findings
 * @typedef {'functional' | 'errors' | 'visual' | 'accessibility' | 'theme' | 'performance' | 'agent' | 'maintenance'} Category
 * @typedef {object} Finding
 * @property {string} id
 * @property {Severity} severity
 * @property {Category} category
 * @property {string} [area]  where it happens, e.g. a page name
 * @property {string} title
 * @property {string} detail
 * @property {string[]} testIds
 * @property {string} [image]  screenshot that shows it, relative to the run dir
 * @property {Pick<import('../core/types.js').Explanation, 'cause' | 'category' | 'confidence'>} [ai]
 *   the AI's reading of the first failed test it covers, when one was written (data from the report, no call here)
 * @typedef {{ expected: string, actual: string, kind: Expectation['kind'] }} Reason
 * @typedef {object} FlowStep
 * @property {number} n  1-based, over the steps shown
 * @property {number} index  index in the trace
 * @property {string} description
 * @property {boolean} ok
 * @property {TraceEntry['source']} source
 * @property {string} tool
 * @property {string} [screenshot]
 * @typedef {object} FlowPage
 * @property {string} key
 * @property {string} name
 * @property {string} [url]
 * @property {'ok' | 'stuck' | 'unreached'} status
 * @property {FlowStep[]} steps
 * @property {number} observed  steps that only looked at the page
 * @property {string} [screenshot]  the last screenshot taken on this page
 * @typedef {object} TestInsight
 * @property {string} id
 * @property {string} title
 * @property {TestResult['verdict']['status']} status
 * @property {string} outcome  one line: what happened
 * @property {Reason[]} reasons  failed checks, in plain words (empty on a pass)
 * @property {{ label: string, passed: boolean, vacuous: boolean, advisory: boolean, kind: Expectation['kind'] }[]} checks
 * @property {string} [pageMessage]  an error the page itself showed at the end
 * @property {FlowStep} [failedStep]
 * @property {string} how  e.g. "Replay · 9 steps"
 * @property {number} stepCount
 * @property {FlowPage[]} pages
 * @property {number} tokens
 * @typedef {object} RunInsights
 * @property {string} headline
 * @property {string} sentence
 * @property {'ok' | 'bad' | 'warn'} tone
 * @property {{ flows: { passed: number, total: number }, problems: number, review: number, visual: { tests: number, minPct: number, maxPct: number }, cost: { agentTokens: number, overheadTokens: number, cachedTokens: number, replayed: number, total: number } }} kpis
 *   cachedTokens: of all those tokens, the input read back from the prompt cache (billed at a tenth or less)
 * @property {Finding[]} findings
 * @property {Record<string, TestInsight>} tests
 */

const GUARDS = new Set(['no-console-errors', 'no-network-failures']);
const QUALITY = new Set([
  'web-vitals',
  'no-a11y-violations',
  'theme-conformance',
  'visual-baseline',
]);
export const SEVERITY_ORDER = /** @type {Severity[]} */ (['high', 'medium', 'review', 'low']);

/** @param {string} s */
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** @param {string} s */
const lower = (s) => (s && !/^[A-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** @param {number} r */
const pct = (r) => Math.max(r > 0 ? 1 : 0, Math.round(r * 100));

/** @param {string} u */
function parseUrl(u) {
  try {
    return new URL(u, 'http://x.invalid');
  } catch {
    return null;
  }
}

/** Route of a URL: path plus hash route, without the query ("/cart.html", "/#/active"). */
export function pageKey(/** @type {string | undefined} */ url) {
  const u = parseUrl(url ?? '');
  if (!u) return String(url ?? '');
  const hash = u.hash.startsWith('#/') ? u.hash : '';
  return `${u.pathname.replace(/\/+$/, '') || '/'}${hash}`;
}

/** A page name a person would use: "/checkout-step-one.html" -> "Checkout step one", "/" -> "Home". */
export function pageName(/** @type {string | undefined} */ url) {
  const key = pageKey(url);
  const segs = key
    .replace(/^#/, '')
    .split(/[/#]/)
    .filter(Boolean)
    .map((s) => decodeURIComponent(s).replace(/\.(html?|php|aspx?|jsp)$/i, ''));
  // ids say nothing to a reader: "/deck/8f3a…" is a deck page
  const named = segs.filter((s) => !/^[0-9a-f-]{6,}$|^\d+$/i.test(s));
  const last = named.at(-1);
  if (!last || last === 'index') return 'Home';
  const words = last.replace(/[-_.]+/g, ' ').trim();
  return cap(named.length < segs.length ? `${words} (one item)` : words);
}

/** Words in a test id or class name: "inventory-item-price" -> "inventory item price". */
const words = (/** @type {string} */ s) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .trim();

/** A selector, said in words: the best we can do without a label. */
function selectorWords(/** @type {string} */ sel) {
  const alt = /@alt\s*=\s*['"]([^'"]+)['"]/.exec(sel)?.[1];
  const testId = /data-(?:testid|test-id|test|cy|qa)\s*=\s*\\?['"]([^'"\\]+)/.exec(sel)?.[1];
  const aria = /aria-label\s*=\s*\\?['"]([^'"\\]+)/.exec(sel)?.[1];
  const text = /(?:normalize-space\(\)|text\(\))\s*=\s*['"]([^'"]+)['"]/.exec(sel)?.[1];
  const count = /count\([^)]*\)\s*=\s*(\d+)/.exec(sel)?.[1];
  const subject = alt
    ? `the ${alt} image`
    : testId
      ? `the ${words(testId)}`
      : aria
        ? `the ${aria} control`
        : 'the expected element';
  if (count) return `${subject} holds ${plural(Number(count), 'item')}`;
  if (text) return `${subject} reads “${text}”`;
  return `${subject} is shown`;
}

/** What a check proves, in words: its label when it has one. */
export function checkLabel(/** @type {Expectation} */ e) {
  if (e.label) return e.label;
  switch (e.kind) {
    case 'url':
      return e.mode === 'regex'
        ? `The page address matches ${e.pattern}`
        : `The “${pageName(e.pattern)}” page opens`;
    case 'text-visible':
      return `“${clip(e.text, 80)}” is shown`;
    case 'text-appeared':
      return `“${clip(e.text, 80)}” appears`;
    case 'selector-visible':
      return cap(selectorWords(e.selector));
    case 'visual':
      return e.question;
    case 'api-call':
      return `The app calls ${[e.method, e.urlPattern].filter(Boolean).join(' ')}${e.status ? ` and gets ${e.status}` : ''}`;
    case 'download':
      return e.filenamePattern ? `A ${e.filenamePattern} file downloads` : 'A file downloads';
    case 'web-vitals':
      return 'The page loads and responds fast enough';
    case 'theme-conformance':
      return 'Colours, corners and fonts follow the app’s theme';
    case 'no-a11y-violations':
      return `No ${e.minImpact ?? 'serious'} accessibility problems`;
    case 'no-console-errors':
      return 'No errors in the browser console';
    case 'no-network-failures':
      return 'No failed requests';
    case 'visual-baseline':
      return 'Screens look like the approved version';
    default:
      return /** @type {any} */ (e).kind;
  }
}

/** What the judge found instead, in words. */
function actualText(/** @type {CheckResult} */ c, /** @type {TestResult} */ r) {
  const e = c.expectation;
  switch (e.kind) {
    case 'url':
      return `The test ended on “${pageName(r.evidence.finalUrl)}”`;
    case 'text-visible':
      return `“${clip(e.text, 80)}” was not on the final page`;
    case 'text-appeared':
      return `“${clip(e.text, 80)}” never appeared`;
    case 'selector-visible':
      return 'It was not found on the final page';
    case 'visual':
      return `The AI looking at the screenshots answered no${c.detail.includes(':') ? `: ${clip(c.detail.split(/:\s(.+)/)[1] ?? '', 140)}` : ''}`;
    case 'no-console-errors': {
      // the judge's own detail names the first error it did not ignore: "8 console error(s): <message>"
      const m = /^(\d+) console error\(s\):\s*([\s\S]*)$/.exec(c.detail);
      const err = r.evidence.console.find((x) => x.type === 'error' || x.type === 'pageerror');
      const text = m?.[2] || err?.text;
      if (!text) return clip(c.detail, 160);
      const n = Number(m?.[1] ?? 1);
      return `${n > 1 ? `${n} errors in the console, first: ` : ''}${n > 1 ? explainError(text) : cap(explainError(text))}`;
    }
    case 'no-network-failures': {
      const f = r.evidence.networkFailures[0];
      return f
        ? `${f.method} ${pageKey(f.url)} failed${f.status ? ` with ${f.status}` : f.failure ? ` (${f.failure})` : ''}`
        : clip(c.detail, 160);
    }
    default:
      return clip(c.detail, 160);
  }
}

const PAGE_ERROR =
  /\b(error|required|invalid|failed|failure|wrong|not found|denied|unable|could not|couldn't|try again|went wrong|forbidden|unauthori[sz]ed|expired)\b/i;

/** An error the page itself shows ("Error: Last Name is required"), from the final page text. */
function pageMessage(/** @type {TestResult} */ r) {
  const lines = (r.evidence.pageTextExcerpt ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 6 && l.length <= 160);
  return lines.find((l) => PAGE_ERROR.test(l));
}

/** The pages a test went through, in order, with its steps grouped under each. */
function flowPages(/** @type {TestResult} */ r, /** @type {boolean} */ stuck) {
  /** @type {FlowPage[]} */
  const pages = [];
  const trace = r.trace ?? [];
  let n = 0;
  /** @param {string | undefined} url */
  const pageFor = (url) => {
    const key = pageKey(url ?? r.test.startUrl);
    const last = pages.at(-1);
    if (last && last.key === key) return last;
    /** @type {FlowPage} */
    const p = {
      key,
      name: pageName(url ?? r.test.startUrl),
      url,
      status: 'ok',
      steps: [],
      observed: 0,
    };
    pages.push(p);
    return p;
  };
  if (trace.length) {
    for (const t of trace) {
      const p = pageFor(t.url ?? pages.at(-1)?.url);
      if (t.screenshot) p.screenshot = t.screenshot;
      if (t.observe) {
        p.observed++;
        continue;
      }
      p.steps.push({
        n: ++n,
        index: t.index,
        // opening a page says "Open http://…": a reader wants the page's name
        description: t.tool === 'goto' ? `Opened “${p.name}”` : t.description,
        ok: t.ok,
        source: t.source,
        tool: t.tool,
        screenshot: t.screenshot,
      });
    }
  } else {
    for (const s of r.evidence.screenshots ?? []) {
      const p = pageFor(s.url);
      p.screenshot = s.path;
    }
  }
  // the final screen, as the judge saw it
  const finalKey = pageKey(r.evidence.finalUrl);
  const end =
    pages.at(-1)?.key === finalKey || !r.evidence.finalUrl
      ? pages.at(-1)
      : pageFor(r.evidence.finalUrl);
  const finalShot = [...(r.evidence.screenshots ?? [])].reverse().find((s) => s.label === 'final');
  if (end && finalShot && pageKey(finalShot.url) === end.key) end.screenshot = finalShot.path;
  if (end && stuck) end.status = 'stuck';
  // pages the test should have reached and did not
  for (const c of r.verdict.checks)
    if (c.expectation.kind === 'url' && !c.passed && c.expectation.mode !== 'regex')
      pages.push({
        key: `unreached:${c.expectation.pattern}`,
        name: pageName(c.expectation.pattern),
        status: 'unreached',
        steps: [],
        observed: 0,
      });
  return pages;
}

function howItRan(
  /** @type {TestResult} */ r,
  /** @type {number} */ steps,
  /** @type {number} */ tokens,
) {
  const s = plural(steps, 'step');
  const t = tokens ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : '';
  switch (r.mode) {
    case 'replay':
      return `Replay · ${s}`;
    case 'healed':
      return `Healed by AI · ${s}${t}`;
    case 'agent':
      return `AI agent · ${s}${t}`;
    default:
      return steps ? `Scripted · ${s}` : 'Page check';
  }
}

/**
 * The flow did what it should (every outcome check held, with real evidence) and failed only on the app's own
 * errors: console errors or failed requests. Worth telling apart from a broken flow.
 * @param {TestResult} r
 */
function reachedButErrors(r) {
  if (r.verdict.status !== 'fail') return false;
  const hard = r.verdict.checks.filter((c) => !c.advisory);
  const failed = hard.filter((c) => !c.passed);
  const outcomes = hard.filter((c) => !GUARDS.has(c.expectation.kind));
  return (
    failed.length > 0 &&
    failed.every((c) => GUARDS.has(c.expectation.kind)) &&
    outcomes.some((c) => c.passed && !c.vacuous) &&
    !(r.trace ?? []).some((t) => !t.ok && !t.observe)
  );
}

/** @param {TestResult} r @returns {TestInsight} */
export function testInsight(r) {
  const { verdict } = r;
  const failedChecks = verdict.checks.filter((c) => !c.passed && !c.advisory);
  const failedOutcome = failedChecks.filter((c) => !GUARDS.has(c.expectation.kind));
  const trace = r.trace ?? [];
  const bad = [...trace].reverse().find((t) => !t.ok && !t.observe);
  const urlMiss = failedChecks.find((c) => c.expectation.kind === 'url');
  const failing = verdict.status !== 'pass';
  const stuck = failing && (!!bad || !!urlMiss || verdict.status === 'error');
  const pages = flowPages(r, stuck);
  const steps = pages.flatMap((p) => p.steps);
  const failedStep = bad ? steps.find((s) => s.index === bad.index) : undefined;
  const acted = steps.filter((s) => s.source !== 'harness').length;
  const tokens = (r.llmUsage?.inputTokens ?? 0) + (r.llmUsage?.outputTokens ?? 0);
  const message = failing ? pageMessage(r) : undefined;
  /** @type {Reason[]} */
  const reasons = failedChecks.map((c) => ({
    expected: checkLabel(c.expectation),
    actual: actualText(c, r),
    kind: c.expectation.kind,
  }));
  const where = pageName(r.evidence.finalUrl || r.test.startUrl);
  const inconclusive = failing && !failedChecks.length && /^Inconclusive/.test(verdict.reason);

  let outcome;
  const unhelped = r.help?.find((h) => h.answer !== 'done');
  if (failing && verdict.status !== 'error' && neededPerson(r.help) && unhelped)
    outcome = `Needs a person: ${lower(clip(unhelped.what, 90))}`;
  else if (verdict.status === 'error')
    outcome = `Could not run: ${clip(verdict.reason.replace(/^Execution error:\s*/, ''), 90)}`;
  else if (verdict.status === 'pass') {
    const proof = verdict.checks.find(
      (c) =>
        c.passed &&
        !c.vacuous &&
        !c.advisory &&
        !GUARDS.has(c.expectation.kind) &&
        !QUALITY.has(c.expectation.kind),
    );
    outcome = proof
      ? checkLabel(proof.expectation)
      : `Passed ${plural(verdict.checks.filter((c) => !c.advisory).length, 'check')}`;
    if (wasHelped(r.help)) outcome = `${outcome} (a person helped)`;
  } else if (stuck) {
    const what = message
      ? `“${clip(message, 70)}”`
      : failedStep
        ? `could not ${lower(clip(failedStep.description, 60))}`
        : urlMiss
          ? `never reached “${pageName(urlMiss.expectation.kind === 'url' ? urlMiss.expectation.pattern : '')}”`
          : '';
    outcome = `Stuck on “${where}”${what ? `: ${what}` : ''}`;
  } else if (inconclusive) outcome = 'Nothing showed the goal was reached';
  else if (reachedButErrors(r)) outcome = `Goal reached, but ${lower(reasons[0].actual)}`;
  else if (failedOutcome.length) {
    const first = checkLabel(failedOutcome[0].expectation);
    outcome = `Not as expected: ${lower(clip(first, 70))}${failedOutcome.length > 1 ? ` (+${failedOutcome.length - 1} more)` : ''}`;
  } else if (reasons.length) outcome = reasons[0].actual;
  else outcome = clip(verdict.reason, 90);

  return {
    id: r.test.id,
    title: r.test.title,
    status: verdict.status,
    outcome,
    reasons,
    checks: verdict.checks.map((c) => ({
      label: checkLabel(c.expectation),
      passed: c.passed,
      vacuous: !!c.vacuous,
      advisory: !!c.advisory,
      kind: c.expectation.kind,
    })),
    pageMessage: message,
    failedStep,
    how: howItRan(r, acted, tokens),
    stepCount: acted,
    pages,
    tokens,
  };
}

/** The screenshot that best shows where a test went wrong. */
const shotOf = (/** @type {TestInsight} */ t) =>
  t.pages.filter((p) => p.status !== 'unreached' && p.screenshot).at(-1)?.screenshot;

const STOPPED_BEFORE = /^Stopped before this test started/;

/**
 * Which results a stop cut off: errors in a stopped run. Reports written before `report.stopped` existed are
 * recognised by a test that was stopped before it started, which only happens when the run was stopped.
 * @param {RunReport} report @returns {(r: TestResult) => boolean}
 */
export function cutOffBy(report) {
  const stopped =
    !!report.stopped ||
    report.results.some(
      (r) => r.verdict.status === 'error' && STOPPED_BEFORE.test(r.verdict.reason),
    );
  return (r) => r.verdict.status === 'error' && stopped;
}

/** @param {RunReport} report @returns {RunInsights} */
export function runInsights(report) {
  const results = report.results;
  /** @type {Record<string, TestInsight>} */
  const tests = {};
  for (const r of results) tests[r.test.id] = testInsight(r);
  /** @type {Finding[]} */
  const findings = [];
  const add = (/** @type {Omit<Finding, 'id'>} */ f) =>
    findings.push({ id: `${f.category}-${findings.length + 1}`, ...f });

  // A stopped run cuts tests off: that says nothing about the app, so they are not problems.
  const cutOff = cutOffBy(report);
  const notRun = results.filter(cutOff);
  // Stopped at a step only a person can do: not an app problem, listed on its own.
  const awaitsPerson = (/** @type {TestResult} */ r) =>
    !cutOff(r) && r.verdict.status === 'fail' && neededPerson(r.help);
  const needPerson = results.filter(awaitsPerson);

  // 1. Blocked flows: tests that got stuck on the same page are one problem.
  /** @type {Map<string, TestResult[]>} */
  const stuck = new Map();
  for (const r of results) {
    const t = tests[r.test.id];
    if (cutOff(r) || awaitsPerson(r)) continue;
    if (r.verdict.status === 'error') {
      add({
        severity: 'high',
        category: 'functional',
        area: pageName(r.test.startUrl),
        title: `“${r.test.title}” could not run`,
        detail: clip(r.verdict.reason.replace(/^Execution error:\s*/, ''), 220),
        testIds: [r.test.id],
        image: shotOf(t),
      });
    } else if (t.status === 'fail' && t.pages.some((p) => p.status === 'stuck')) {
      const key = pageKey(r.evidence.finalUrl);
      stuck.set(key, [...(stuck.get(key) ?? []), r]);
    }
  }
  for (const [, rs] of stuck) {
    const ts = rs.map((r) => tests[r.test.id]);
    const name = pageName(rs[0].evidence.finalUrl);
    const message = ts.find((t) => t.pageMessage)?.pageMessage;
    const step = ts.find((t) => t.failedStep)?.failedStep;
    const missed = [
      ...new Set(
        ts.flatMap((t) => t.pages.filter((p) => p.status === 'unreached').map((p) => p.name)),
      ),
    ];
    const parts = [
      message && `The page shows “${clip(message, 120)}”.`,
      step && `“${clip(step.description, 80)}” could not be done.`,
      missed.length &&
        `${missed.map((m) => `“${m}”`).join(' and ')} ${missed.length > 1 ? 'were' : 'was'} never reached.`,
    ].filter(Boolean);
    add({
      severity: 'high',
      category: 'functional',
      area: name,
      title: `${rs.length > 1 ? `${rs.length} flows get` : 'The flow gets'} stuck on “${name}”`,
      detail: parts.join(' ') || clip(rs[0].verdict.reason, 220),
      testIds: rs.map((r) => r.test.id),
      image: shotOf(ts[0]),
    });
  }

  // 2. Wrong results: the flow finished, but what it should show is not there.
  for (const r of results) {
    const t = tests[r.test.id];
    if (t.status !== 'fail' || t.pages.some((p) => p.status === 'stuck') || awaitsPerson(r))
      continue;
    const outcomes = t.reasons.filter((x) => !GUARDS.has(x.kind));
    if (!outcomes.length) {
      if (!t.reasons.length)
        add({
          severity: 'medium',
          category: 'functional',
          area: pageName(r.evidence.finalUrl),
          title: `Nothing showed that “${r.test.title}” worked`,
          detail: clip(r.verdict.reason, 220),
          testIds: [r.test.id],
          image: shotOf(t),
        });
      continue;
    }
    const more = outcomes.slice(1).map((x) => x.expected);
    // the AI's reading says the test itself is wrong: still shown, but as something to review, not an app bug
    const testProblem = r.explanation?.category === 'test-problem';
    add({
      severity: testProblem ? 'review' : 'medium',
      category: 'functional',
      area: pageName(r.evidence.finalUrl),
      title: `Expected: ${lower(outcomes[0].expected)}`,
      detail: `${outcomes[0].actual}.${more.length ? ` Also not true: ${more.map(lower).join('; ')}.` : ''}`,
      testIds: [r.test.id],
      image: shotOf(t),
    });
  }

  // 3. Errors the app raised (console, network), grouped by message across tests.
  /** @type {Map<string, { title: string, detail: string, ids: string[], area: string }>} */
  const errs = new Map();
  for (const r of results) {
    for (const c of r.verdict.checks) {
      if (c.passed || c.advisory || !GUARDS.has(c.expectation.kind)) continue;
      const actual = actualText(c, r);
      const key = `${c.expectation.kind}|${actual.replace(/\d+/g, '#')}`;
      const e = errs.get(key) ?? {
        title:
          c.expectation.kind === 'no-console-errors'
            ? 'The app reports an error'
            : 'Requests to the server fail',
        detail: actual,
        ids: [],
        area: pageName(r.evidence.finalUrl),
      };
      e.ids.push(r.test.id);
      errs.set(key, e);
    }
  }
  // A failed request usually also shows up as a console error ("a request failed with HTTP 502"): one
  // problem, reported once, on the request.
  const sameIds = (/** @type {string[]} */ a, /** @type {string[]} */ b) =>
    a.length === b.length && a.every((x) => b.includes(x));
  for (const [key, e] of errs) {
    const status = /^a request failed with HTTP (\d{3})$/i.exec(e.detail)?.[1];
    if (!key.startsWith('no-console-errors|') || !status) continue;
    const net = [...errs.entries()].find(
      ([k, n]) =>
        k.startsWith('no-network-failures|') && n.detail.includes(status) && sameIds(n.ids, e.ids),
    );
    if (net) errs.delete(key);
  }
  for (const e of errs.values()) {
    // flows that did what they should but failed only because of this error: the error is the cause
    const blocked = e.ids.filter((id) => {
      const r = results.find((x) => x.test.id === id);
      return r && reachedButErrors(r);
    }).length;
    add({
      severity: blocked >= 2 ? 'high' : 'medium',
      category: 'errors',
      area: e.area,
      title:
        blocked >= 2
          ? `${e.title.startsWith('Requests') ? 'A server request fails' : 'An app error'} and breaks ${blocked} flows that otherwise work`
          : e.title,
      detail: e.detail,
      testIds: e.ids,
    });
  }

  // 4. The AI said it succeeded; the evidence disagreed. Worth seeing: it is why the judge exists.
  // only where the goal itself was not reached: an agent that reached it on an app that logs errors was right
  const lied = results.filter(
    (r) =>
      r.claimMismatch &&
      r.agentClaim?.success &&
      r.verdict.status !== 'pass' &&
      !reachedButErrors(r) &&
      !awaitsPerson(r) &&
      // when the AI's reading says the test was wrong, the agent may well have been right
      r.explanation?.category !== 'test-problem',
  );
  if (lied.length)
    add({
      severity: 'review',
      category: 'agent',
      title: `The AI agent said ${lied.length > 1 ? `${lied.length} tests` : 'a test'} succeeded; the evidence disagreed`,
      detail:
        'The verdict comes from the page, the network and screenshots, never from the agent’s own report. These failures would have been reported as passes otherwise.',
      testIds: lied.map((r) => r.test.id),
    });

  // 5. Screens that look different from the approved version: a decision, not automatically a bug.
  const changed = results
    .map((r) => ({
      r,
      v: (r.evidence.visual?.results ?? []).filter(
        (x) => x.status === 'changed' || x.status === 'size',
      ),
    }))
    .filter((x) => x.v.length);
  if (changed.length) {
    const ratios = changed.flatMap((x) => x.v.map((v) => v.diffRatio ?? 0));
    const lo = pct(Math.min(...ratios));
    const hi = pct(Math.max(...ratios));
    const screens = changed.reduce((n, x) => n + x.v.length, 0);
    add({
      severity: 'review',
      category: 'visual',
      title: `${plural(screens, 'screen')} look${screens === 1 ? 's' : ''} different from the approved version`,
      detail: `${lo === hi ? `${lo}%` : `${lo}–${hi}%`} of pixels differ, in ${plural(changed.length, 'test')}. Approve the new look if the change was intended; otherwise it is a bug.`,
      testIds: changed.map((x) => x.r.test.id),
      image: changed[0].v[0].diff ?? changed[0].v[0].current,
    });
  }

  // 6. Advisory quality findings: one card per kind, never a verdict on their own.
  /** @type {[Expectation['kind'], Category, string][]} */
  const QUALITY_CARDS = [
    ['no-a11y-violations', 'accessibility', 'Accessibility problems'],
    ['theme-conformance', 'theme', 'Colours or fonts that ignore the app’s theme'],
    ['web-vitals', 'performance', 'Pages that load or respond slowly'],
  ];
  for (const [kind, category, title] of QUALITY_CARDS) {
    const hits = results.flatMap((r) =>
      r.verdict.checks
        .filter((c) => c.expectation.kind === kind && !c.passed)
        .map((c) => ({ r, c })),
    );
    if (!hits.length) continue;
    const ids = [...new Set(hits.map((h) => h.r.test.id))];
    const a11y =
      kind === 'no-a11y-violations'
        ? [
            ...new Set(
              hits.flatMap((h) => (h.r.evidence.a11y?.violations ?? []).map((v) => v.help)),
            ),
          ]
        : [];
    add({
      severity: hits.some((h) => !h.c.advisory) ? 'medium' : 'low',
      category,
      title,
      detail: a11y.length
        ? `${a11y.slice(0, 3).join('; ')}${a11y.length > 3 ? `, and ${a11y.length - 3} more` : ''}.`
        : clip(hits[0].c.detail, 220),
      testIds: ids,
    });
  }

  // 7. Recordings that went stale and were repaired: visible, because a heal must never hide anything.
  const healed = results.filter((r) => r.heals.some((h) => h.outcome === 'healed'));
  if (healed.length)
    add({
      severity: 'low',
      category: 'maintenance',
      title: `${plural(healed.length, 'recording')} ${healed.length > 1 ? 'were' : 'was'} out of date and repaired by the AI`,
      detail:
        'A replayed step no longer matched the page, so the agent took over from that step. The repaired test was judged by the same checks; review the heal if the page change was not expected.',
      testIds: healed.map((r) => r.test.id),
    });

  // 8b. Tests that passed only on a second try, after the AI's reading of the first failure: a person should
  // know the test needed help, even though the evidence passed it.
  const retried = results.filter((r) => r.retry?.passed);
  for (const r of retried)
    add({
      severity: 'review',
      category: 'agent',
      title: `“${r.test.title}” passed on a second try`,
      detail: `The first try failed (${clip(r.retry?.other.reason ?? '', 120)}). The AI's reading blamed the test, not the app: ${clip(r.retry?.hint ?? '', 200)} The second try used that and passed the same checks. Consider rewording the test's goal.`,
      testIds: [r.test.id],
    });

  // 8c. Human in the loop: tests that need a person nobody provided, and tests a person helped. Both are things to
  // look at, never app problems, and a helped pass is never presented as a clean one.
  if (needPerson.length)
    add({
      severity: 'review',
      category: 'agent',
      title: `${plural(needPerson.length, 'test')} need${needPerson.length === 1 ? 's' : ''} a person`,
      detail: `${needPerson
        .map(
          (r) =>
            `“${r.test.title}”: ${clip(r.help?.find((h) => h.answer !== 'done')?.what ?? '', 120)}`,
        )
        .join(
          '; ',
        )}. A step only a human can do; nobody could help in this run. Run it with the browser shown to help when the agent asks.`,
      testIds: needPerson.map((r) => r.test.id),
    });
  const helped = results.filter((r) => r.verdict.status === 'pass' && wasHelped(r.help));
  for (const r of helped)
    add({
      severity: 'review',
      category: 'agent',
      title: `“${r.test.title}” passed with a person's help`,
      detail: `A person did: ${r.help
        ?.filter((h) => h.answer === 'done')
        .map((h) => clip(h.what, 120))
        .join(
          '; ',
        )}. The checks passed on what the page showed afterwards. Not recorded: a replay cannot repeat what a person did.`,
      testIds: [r.test.id],
    });

  // 8. Passing runs whose steps did not replay on their own: not saved, so every run pays for the agent again.
  const unsaved = results.filter((r) => r.recording && !r.recording.saved);
  if (unsaved.length)
    add({
      severity: 'review',
      category: 'maintenance',
      title: `${plural(unsaved.length, 'test')} passed but could not be recorded`,
      detail: `Replaying the agent's steps once, with no AI, did not pass${unsaved[0].recording?.reason ? ` (${clip(unsaved[0].recording.reason, 140)})` : ''}. The next run uses the agent again. Often a wait or a hover the steps do not capture; stable test ids on the controls help.`,
      testIds: unsaved.map((r) => r.test.id),
    });

  // attach the AI's reading (already in the report) to the failures it explains
  const byId = new Map(results.map((r) => [r.test.id, r]));
  for (const f of findings) {
    if (!['functional', 'errors'].includes(f.category)) continue;
    const e = f.testIds.map((id) => byId.get(id)?.explanation).find(Boolean);
    if (e) f.ai = { cause: e.cause, category: e.category, confidence: e.confidence };
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  const s = report.summary;
  const problems = findings.filter((f) => f.severity === 'high' || f.severity === 'medium').length;
  const review = findings.filter((f) => f.severity === 'review').length;
  const failing = results
    .filter((r) => r.verdict.status !== 'pass' && !cutOff(r) && !awaitsPerson(r))
    .map((r) => r.test.title);
  const stoppedNote = notRun.length
    ? `${plural(notRun.length, 'test')} did not finish because the run was stopped.`
    : '';
  const personNote = needPerson.length
    ? `${plural(needPerson.length, 'test')} need${needPerson.length === 1 ? 's' : ''} a person for a step only a human can do.`
    : '';
  const who = report.auth ? ` for ${report.auth.username}` : '';
  let headline;
  let sentence;
  /** @type {RunInsights['tone']} */
  let tone;
  if (!s.total) {
    headline = 'No tests ran';
    sentence = 'The plan was empty: add a description or a suite and run again.';
    tone = 'warn';
  } else if (problems) {
    headline = `${plural(problems, 'problem')} found`;
    const errorsOnly = results.filter(reachedButErrors).map((r) => r.test.title);
    const broken = failing.filter((t) => !errorsOnly.includes(t));
    sentence = [
      `${s.passed} of ${plural(s.total, 'flow')} work${s.total === 1 && s.passed === 1 ? 's' : ''}${who}.`,
      errorsOnly.length
        ? `${errorsOnly.length === 1 ? '1 more reaches its goal but fails' : `${errorsOnly.length} more reach their goal but fail`} because the app logs errors or requests fail.`
        : '',
      broken.length
        ? `Failing: ${broken
            .slice(0, 3)
            .map((t) => `“${t}”`)
            .join(', ')}${broken.length > 3 ? `, and ${broken.length - 3} more` : ''}.`
        : '',
      stoppedNote,
      personNote,
    ]
      .filter(Boolean)
      .join(' ');
    tone = 'bad';
  } else if (notRun.length) {
    const checked = s.total - notRun.length;
    headline = `Stopped after ${checked} of ${plural(s.total, 'test')}`;
    sentence = `${s.passed} of ${plural(checked, 'checked flow')} work${who}. ${[stoppedNote, personNote].filter(Boolean).join(' ')}`;
    tone = 'warn';
  } else if (needPerson.length) {
    headline = `${plural(needPerson.length, 'test')} need${needPerson.length === 1 ? 's' : ''} a person`;
    sentence = `${s.passed} of ${plural(s.total, 'flow')} work${who}. ${personNote} Run with the browser shown to help when the agent asks.`;
    tone = 'warn';
  } else {
    headline = s.total === 1 ? 'The flow works' : `All ${s.total} flows work`;
    sentence = review
      ? `Every check was confirmed from the page, the network and screenshots${who}. ${plural(review, 'thing')} to review.`
      : `Every check was confirmed from the page, the network and screenshots${who}.`;
    tone = review ? 'warn' : 'ok';
  }
  const visualRatios = results.flatMap((r) =>
    (r.evidence.visual?.results ?? [])
      .filter((v) => v.status === 'changed' || v.status === 'size')
      .map((v) => v.diffRatio ?? 0),
  );
  return {
    headline,
    sentence,
    tone,
    kpis: {
      flows: { passed: s.passed, total: s.total },
      problems,
      review,
      visual: {
        tests:
          s.visualChanges ??
          results.filter(
            (r) =>
              tests[r.test.id] &&
              (r.evidence.visual?.results ?? []).some(
                (v) => v.status === 'changed' || v.status === 'size',
              ),
          ).length,
        minPct: visualRatios.length ? pct(Math.min(...visualRatios)) : 0,
        maxPct: visualRatios.length ? pct(Math.max(...visualRatios)) : 0,
      },
      cost: {
        agentTokens: s.inputTokens + s.outputTokens,
        overheadTokens: (s.overhead?.inputTokens ?? 0) + (s.overhead?.outputTokens ?? 0),
        cachedTokens: (s.cachedInputTokens ?? 0) + (s.overhead?.cachedInputTokens ?? 0),
        replayed: results.filter((r) => r.mode === 'replay' || r.mode === 'deterministic').length,
        total: s.total,
      },
    },
    findings,
    tests,
  };
}
