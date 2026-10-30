import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { compareCaptures, pct } from '../visual/check.js';

/**
 * @import { BrowserSession } from '../browser/session.js'
 * @import { Config } from '../config/config.js'
 * @import { Judge, LlmClient } from '../core/ports.js'
 * @import { Baseline, CheckResult, Evidence, ExecutionOutcome, Expectation, TestCase, Verdict } from '../core/types.js'
 */

const VisualAnswerSchema = z.object({
  answer: z.boolean().describe('true only if the screenshot clearly shows what the question asks'),
  reasoning: z.string().describe('One or two sentences citing what is visible'),
});

const VISUAL_SYSTEM = `You are a strict visual QA judge for an automated browser test.
You get screenshots of ONE browser tab in time order and a yes/no question. The FIRST image is the page
before the test acted, the LAST image is the page as it is now, any images in between were captured
while the test ran. All of them are real captures by the test harness.
- For a question about the end state ("is X shown?"), answer from the LAST image.
- For a question about a change or an action ("did X change?", "was a slide added?"), compare the
  images, especially the first and the last.
- Answer true only if the images clearly show it. Unclear, partially shown, or absent = false.
- Do not guess the product's name or assume anything you cannot see.`;

/** Checks whose evidence is deterministic (not an LLM reading pixels). */
const HARD_KINDS = new Set([
  'url',
  'text-visible',
  'selector-visible',
  'api-call',
  'download',
  'text-appeared',
]);

/** Checks that guard against regressions rather than prove the goal was reached. */
const GUARD_KINDS = new Set([
  'visual-baseline',
  'no-console-errors',
  'no-network-failures',
  'web-vitals',
  'no-a11y-violations',
  'theme-conformance',
]);
const IMPACT_RANK = { minor: 1, moderate: 2, serious: 3, critical: 4 };
const VITAL_KEYS = /** @type {const} */ ([
  ['LCP', 'lcpMs', 'ms'],
  ['CLS', 'cls', ''],
  ['INP', 'inpMs', 'ms'],
  ['FCP', 'fcpMs', 'ms'],
  ['TTFB', 'ttfbMs', 'ms'],
]);

/** Substring match, or regex when the pattern is one. @param {string} pattern @param {string} value */
function textMatches(pattern, value) {
  if (value.toLowerCase().includes(pattern.toLowerCase())) return true;
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return false;
  }
}

/** @param {number} v @param {string} unit */
const fmtVital = (v, unit) => (unit === 'ms' ? `${Math.round(v)}ms` : v.toFixed(3));

/**
 * @param {string[]} patterns @param {string} value
 */
const matchesAny = (patterns, value) => patterns.some((p) => new RegExp(p, 'i').test(value));

/**
 * Strict judge. The verdict depends ONLY on harness-collected evidence (DOM, URL, console,
 * network, screenshot) checked against the test's expectations. `outcome.agentClaim` is
 * ignored here on purpose.
 * @implements {Judge}
 */
export class EvidenceJudge {
  /**
   * @param {Config['judge']} cfg
   * @param {LlmClient} [llm]  Needed only for `visual` expectations.
   * @param {Config['quality']} [quality]  Quality gate; default = off (judge only what the test asks).
   * @param {{ store: import('../visual/baselines.js').BaselineStore, cfg: Config['visual'] }} [visual]
   *   Visual regression: captures are compared with the approved baselines; default = no comparison.
   */
  constructor(cfg, llm, quality, visual) {
    this.cfg = cfg;
    this.llm = llm;
    this.quality = quality;
    this.visual = visual;
    // Browsers log failed sub-resources as console errors; ignored network URLs are ignored here too.
    this.consoleIgnore = [
      ...cfg.ignoreConsolePatterns,
      ...cfg.ignoreNetworkPatterns.map((p) => `Failed to load resource.*${p}`),
    ];
  }

  /**
   * @param {TestCase} test @param {BrowserSession} session @param {ExecutionOutcome} outcome
   * @returns {Promise<{ verdict: Verdict, evidence: Evidence }>}
   */
  async judge(test, session, outcome) {
    const evidence = await session.collectEvidence('final').catch(() => emptyEvidence(session));
    if (this.visual && evidence.visual?.captures.length) {
      const v = this.visual;
      const ratio = test.expectations.find((e) => e.kind === 'visual-baseline');
      evidence.visual.results = await compareCaptures({
        test,
        captures: evidence.visual.captures,
        store: v.store,
        maxDiffRatio: ratio?.kind === 'visual-baseline' ? ratio.maxDiffRatio : v.cfg.maxDiffRatio,
        threshold: v.cfg.threshold,
        abs: (rel) => path.join(session.artifacts.runDir, rel),
        rel: (abs) => path.relative(session.artifacts.runDir, abs).split(path.sep).join('/'),
      }).catch(() => undefined);
    }

    /** @type {CheckResult[]} */
    const checks = [];
    for (const expectation of test.expectations) {
      checks.push(await this.#check(expectation, session, evidence));
    }

    /** @type {string[]} */
    const warnings = [];
    const specific = test.expectations.filter((e) => !GUARD_KINDS.has(e.kind));
    if (test.goal.trim() && specific.length === 0) {
      warnings.push(
        'Goal has no outcome expectation (url/text/selector/visual): a pass only means "no errors".',
      );
    }

    // Quality gate: Web Vitals and accessibility are checked on every test, unless the test already
    // sets its own budget. In "warn" mode they are advisory: shown, but they never change the verdict.
    const gate = this.quality?.gate ?? 'off';
    if (gate !== 'off' && this.quality) {
      const q = this.quality;
      /** @type {Expectation[]} */
      const auto = [];
      if (!test.expectations.some((e) => e.kind === 'web-vitals'))
        auto.push({ kind: 'web-vitals', ...q.budgets });
      if (q.a11y && !test.expectations.some((e) => e.kind === 'no-a11y-violations'))
        auto.push({ kind: 'no-a11y-violations', minImpact: q.a11yMinImpact });
      if (
        q.theme &&
        [...(evidence.themeStates ?? []).map((st) => st.audit), evidence.theme].some(
          (a) => a?.themes.length,
        ) &&
        !test.expectations.some((e) => e.kind === 'theme-conformance')
      )
        auto.push({
          kind: 'theme-conformance',
          minScore: q.themeMinScore,
          allowLeaks: false,
          allowHardCoded: false,
        });
      for (const exp of auto) {
        const c = await this.#check(exp, session, evidence);
        c.advisory = gate === 'warn';
        checks.push(c);
        if (!c.passed && c.advisory) warnings.push(`Quality: ${c.detail}`);
      }
      const slow = evidence.requestStats?.slowestApi;
      if (slow && slow.durationMs > q.slowApiMs)
        warnings.push(`Slow API call: ${slow.url} took ${(slow.durationMs / 1000).toFixed(1)}s`);
    }

    // Visual regression has its own gate: an intended redesign is a change to approve, not a bug.
    const vgate = this.visual?.cfg.gate ?? 'off';
    if (
      vgate !== 'off' &&
      !this.visual?.cfg.update && // --update-baselines: the differences are being accepted
      evidence.visual?.results?.some((r) => r.status !== 'new') &&
      !test.expectations.some((e) => e.kind === 'visual-baseline')
    ) {
      const c = await this.#check(
        { kind: 'visual-baseline', maxDiffRatio: this.visual?.cfg.maxDiffRatio ?? 0.001 },
        session,
        evidence,
      );
      c.advisory = vgate === 'warn';
      checks.push(c);
      if (!c.passed && c.advisory) warnings.push(c.detail);
    }

    // An expectation that already held on the start page proves nothing about what the agent did.
    if (outcome.baseline) {
      for (const c of checks) {
        if (c.passed && isVacuous(c.expectation, outcome.baseline, evidence)) {
          c.vacuous = true;
          c.detail += ' (already true before the agent acted: not counted as evidence)';
        }
      }
    }
    const outcomeChecks = checks.filter((c) => !GUARD_KINDS.has(c.expectation.kind));
    const inconclusive =
      test.goal.trim() !== '' &&
      outcomeChecks.length > 0 &&
      !outcomeChecks.some((c) => c.passed && !c.vacuous);

    const failed = checks.filter((c) => !c.passed && !c.advisory);
    /** @type {Verdict['status']} */
    let status = failed.length || inconclusive ? 'fail' : 'pass';
    let reason = failed.length
      ? failed.map((c) => c.detail).join('; ')
      : inconclusive
        ? 'Inconclusive: every outcome expectation was already true on the start page, so nothing shows the goal was achieved. Add an expectation that only holds after the action.'
        : `${checks.filter((c) => !c.advisory).length} check(s) passed`;
    // The judge never trusts a claim of SUCCESS. A claim of FAILURE is different: if the agent says it
    // could not do it and the only proof otherwise is an LLM reading screenshots, believing the pass
    // would be the riskier mistake (a real run passed "navigate between slides" exactly like this).
    if (
      status === 'pass' &&
      test.goal.trim() &&
      outcome.agentClaim &&
      !outcome.agentClaim.success &&
      !checks.some((c) => HARD_KINDS.has(c.expectation.kind) && c.passed && !c.vacuous)
    ) {
      status = 'fail';
      reason =
        'The agent reported it could not complete the goal, and the only evidence of success is an AI reading of screenshots. Treated as a failure; check the step screenshots.';
    }
    if (outcome.failure) {
      status = 'fail';
      reason = `${outcome.failure}${failed.length ? `; ${reason}` : ''}`;
    }
    if (outcome.error) {
      status = 'error';
      reason = `Execution error: ${outcome.error}`;
    }
    return { verdict: { status, reason, checks, warnings }, evidence };
  }

  /**
   * @param {Expectation} exp @param {BrowserSession} session @param {Evidence} evidence
   * @returns {Promise<CheckResult>}
   */
  async #check(exp, session, evidence) {
    /** @param {boolean} passed @param {string} detail @returns {CheckResult} */
    const result = (passed, detail) => ({ expectation: exp, passed, detail });
    switch (exp.kind) {
      case 'url': {
        const ok =
          exp.mode === 'regex'
            ? new RegExp(exp.pattern).test(evidence.finalUrl)
            : evidence.finalUrl.includes(exp.pattern);
        return result(
          ok,
          ok
            ? `URL matches ${exp.pattern}`
            : `URL "${evidence.finalUrl}" does not match "${exp.pattern}"`,
        );
      }
      case 'text-visible': {
        // visible matches only: apps often keep a hidden copy of the same text (closed menus,
        // off-screen slides, responsive duplicates), and .first() alone would pick that copy
        const ok = await session.page
          .getByText(exp.text)
          .filter({ visible: true })
          .first()
          .waitFor({ state: 'visible', timeout: 3000 })
          .then(() => true)
          .catch(() => false);
        return result(ok, ok ? `Text "${exp.text}" visible` : `Text "${exp.text}" not visible`);
      }
      case 'selector-visible': {
        const ok = await session.page
          .locator(exp.selector)
          .filter({ visible: true })
          .first()
          .waitFor({ state: 'visible', timeout: 3000 })
          .then(() => true)
          .catch(() => false);
        return result(ok, ok ? `${exp.selector} visible` : `${exp.selector} not visible`);
      }
      case 'no-console-errors': {
        const bad = evidence.console.filter(
          (c) =>
            (c.type === 'error' || c.type === 'pageerror') &&
            !matchesAny(this.consoleIgnore, `${c.text} ${c.url ?? ''}`),
        );
        return result(
          bad.length === 0,
          bad.length === 0
            ? 'No console errors'
            : `${bad.length} console error(s): ${bad[0]?.text.slice(0, 120)}`,
        );
      }
      case 'no-network-failures': {
        const bad = evidence.networkFailures.filter(
          (n) => !matchesAny(this.cfg.ignoreNetworkPatterns, n.url),
        );
        return result(
          bad.length === 0,
          bad.length === 0
            ? 'No failed requests'
            : `${bad.length} failed request(s): ${bad[0]?.status ?? bad[0]?.failure} ${bad[0]?.url}`,
        );
      }
      case 'visual':
        return this.#visual(exp.question, session, evidence, result);
      case 'api-call': {
        const calls = matchingCalls(exp, evidence);
        const ok = calls.find(
          (r) =>
            (exp.status !== undefined
              ? r.status === exp.status
              : r.status !== undefined && r.status >= 200 && r.status < 400) &&
            (exp.maxDurationMs === undefined ||
              (r.durationMs !== undefined && r.durationMs <= exp.maxDurationMs)),
        );
        if (ok)
          return result(
            true,
            `API call observed: ${ok.method} ${ok.url} -> ${ok.status}${ok.durationMs !== undefined ? ` in ${ok.durationMs}ms` : ''}`,
          );
        const seen = calls
          .slice(0, 3)
          .map(
            (r) =>
              `${r.method} ${r.url} -> ${r.status ?? r.failure ?? '?'}${r.durationMs !== undefined ? ` (${r.durationMs}ms)` : ''}`,
          )
          .join('; ');
        return result(
          false,
          calls.length
            ? `API call to "${exp.urlPattern}" was made but did not meet the expectation: ${seen}`
            : `No ${exp.method ?? ''} request matching "${exp.urlPattern}" was observed`.replace(
                '  ',
                ' ',
              ),
        );
      }
      case 'download': {
        const files = (evidence.downloads ?? []).filter(
          (d) => !exp.filenamePattern || textMatches(exp.filenamePattern, d.filename),
        );
        const f = files[0];
        if (!f)
          return result(
            false,
            `No file download${exp.filenamePattern ? ` matching "${exp.filenamePattern}"` : ''} was observed` +
              ((evidence.downloads ?? []).length
                ? ` (downloads seen: ${(evidence.downloads ?? []).map((d) => d.filename).join(', ')})`
                : ''),
          );
        return result(
          !f.error,
          f.error
            ? `Download "${f.filename}" started but failed: ${f.error}`
            : `Downloaded "${f.filename}"${f.bytes !== undefined ? ` (${f.bytes} bytes)` : ''}`,
        );
      }
      case 'text-appeared': {
        const hit = (evidence.seenText ?? []).find((t) => textMatches(exp.text, t.text));
        if (hit) return result(true, `Message appeared: "${hit.text}"`);
        const visible = await session.page
          .getByText(exp.text)
          .first()
          .isVisible()
          .catch(() => false);
        return result(
          visible,
          visible
            ? `Text "${exp.text}" is visible`
            : `Text "${exp.text}" never appeared in a toast, alert or the page`,
        );
      }
      case 'web-vitals': {
        /** @type {string[]} */
        const bad = [];
        /** @type {string[]} */
        const good = [];
        for (const [name, key, unit] of VITAL_KEYS) {
          const budget = exp[key];
          if (budget === undefined) continue;
          // the worst value across every document the browser loaded
          const values = (evidence.vitals ?? []).flatMap((v) =>
            v.metrics.filter((m) => m.name === name).map((m) => m.value),
          );
          if (!values.length) continue; // not measurable here (e.g. INP needs an interaction)
          const worst = Math.max(...values);
          (worst > budget ? bad : good).push(
            `${name} ${fmtVital(worst, unit)} ${worst > budget ? '>' : '<='} ${fmtVital(budget, unit)}`,
          );
        }
        if (!bad.length && !good.length)
          return result(true, 'Web Vitals: nothing measurable on this page');
        return result(
          bad.length === 0,
          bad.length
            ? `Web Vitals over budget: ${bad.join(', ')}`
            : `Web Vitals within budget: ${good.join(', ')}`,
        );
      }
      case 'theme-conformance': {
        // every distinct screen the test reached (start, after steps, final), not only the last one
        const states = evidence.themeStates?.length
          ? evidence.themeStates
          : evidence.theme
            ? [{ label: 'final', url: evidence.finalUrl, audit: evidence.theme }]
            : [];
        if (!states.length) return result(true, 'Theme audit was not run');
        const audited = states.filter((st) => st.audit.themes.length);
        if (!audited.length) {
          const err = states.find((st) => st.audit.error)?.audit.error;
          return result(
            true,
            err
              ? `Theme audit could not run: ${err}`
              : 'No theme variables found in the build: nothing to check',
          );
        }
        /** the same problem on several screens is reported once, with the screens listed */
        /** @type {Map<string, string[]>} */
        const problems = new Map();
        /** @type {Map<string, number>} lowest score per theme over all screens */
        const lowest = new Map();
        for (const st of audited) {
          for (const p of themeProblems(st.audit, exp))
            problems.set(p, [...(problems.get(p) ?? []), st.label]);
          for (const th of st.audit.themes)
            if (th.score !== null) lowest.set(th.id, Math.min(lowest.get(th.id) ?? 1, th.score));
        }
        const ref = audited.find((st) => st.audit.reference)?.audit.reference;
        const where = (/** @type {string[]} */ labels) =>
          audited.length > 1 ? ` [${[...new Set(labels)].join(', ')}]` : '';
        const screens = `${audited.length} screen${audited.length === 1 ? '' : 's'}`;
        const summary = [...lowest].map(([id, sc]) => `${id} ${Math.round(sc * 100)}%`).join(', ');
        return result(
          problems.size === 0,
          problems.size
            ? `Theme conformance${ref ? ` against ${ref}` : ''}: ${[...problems].map(([p, l]) => `${p}${where(l)}`).join('; ')}`
            : `Theme conformance${ref ? ` against ${ref}` : ''}: ${summary || 'n/a'} ${ref ? 'matching' : 'on-theme'} over ${screens}, no leaks`,
        );
      }
      case 'visual-baseline': {
        const res = evidence.visual?.results ?? [];
        const compared = res.filter((r) => r.status !== 'new');
        if (!compared.length)
          return result(
            true,
            'Visual: no approved baselines yet (this run creates them if it passes)',
          );
        const bad = compared.filter((r) => r.status === 'changed' || r.status === 'size');
        const err = compared.filter((r) => r.status === 'error');
        return result(
          bad.length === 0,
          bad.length
            ? `Visual: ${bad.length} of ${compared.length} screenshot(s) differ from the approved baseline: ${bad
                .slice(0, 4)
                .map(
                  (r) =>
                    `${r.label} (${r.status === 'size' ? (r.note ?? 'size changed') : `${pct(r.diffRatio)} of pixels`})`,
                )
                .join(', ')}`
            : `Visual: ${compared.length - err.length} screenshot(s) match the approved baseline${err.length ? ` (${err.length} could not be compared)` : ''}`,
        );
      }
      case 'no-a11y-violations': {
        const a = evidence.a11y;
        if (!a) return result(true, 'Accessibility scan was not run');
        if (a.error) return result(true, `Accessibility scan could not run: ${a.error}`);
        const min = IMPACT_RANK[exp.minImpact];
        const bad = a.violations.filter(
          (v) =>
            (IMPACT_RANK[/** @type {keyof typeof IMPACT_RANK} */ (v.impact ?? 'minor')] ?? 1) >=
            min,
        );
        return result(
          bad.length === 0,
          bad.length === 0
            ? `No ${exp.minImpact}+ accessibility violations (${a.violations.length} minor/moderate)`
            : `${bad.length} accessibility violation(s) ${exp.minImpact}+: ${bad
                .slice(0, 3)
                .map((v) => `${v.id} (${v.impact}, ${v.nodes} element${v.nodes === 1 ? '' : 's'})`)
                .join(', ')}`,
        );
      }
    }
  }

  /**
   * LLM answers a yes/no question from harness screenshots: the start page, up to three frames from
   * during the run, and the page now. One frame cannot show a change ("was a slide added?"), which
   * produced both false passes and false fails before.
   * @param {string} question @param {BrowserSession} session @param {Evidence} evidence
   * @param {(passed: boolean, detail: string) => CheckResult} result
   */
  async #visual(question, session, evidence, result) {
    if (!this.llm) return result(false, `Visual check "${question}" skipped: no LLM configured`);
    try {
      const images = await timeline(session, evidence);
      const { answer, reasoning } = await this.llm.generateObject({
        schema: VisualAnswerSchema,
        system: VISUAL_SYSTEM,
        prompt: `${images.length} screenshot(s) in time order (first = before the test acted, last = now).\nQuestion: ${question}`,
        images,
      });
      return result(answer, `Visual: "${question}" -> ${answer ? 'yes' : 'no'}. ${reasoning}`);
    } catch (e) {
      return result(false, `Visual check "${question}" failed to run: ${String(e)}`);
    }
  }
}

/**
 * Start screenshot + up to 3 evenly spaced frames from the run + a fresh capture of the page now,
 * skipping consecutive identical frames.
 * @param {BrowserSession} session @param {Evidence} evidence @returns {Promise<Uint8Array[]>}
 */
async function timeline(session, evidence) {
  const shots = evidence.screenshots.filter((s) => s.label !== 'final');
  const start = shots.find((s) => s.label === 'start') ?? shots[0];
  const middle = shots.filter((s) => s !== start);
  /** @type {typeof shots} */
  const picked = [];
  for (let k = 1; k <= 3 && middle.length; k++) {
    const s =
      middle[Math.max(0, Math.min(middle.length - 1, Math.round((k * middle.length) / 4) - 1))];
    if (s && !picked.includes(s)) picked.push(s);
  }
  /** @type {Buffer[]} */
  const images = [];
  for (const ref of [start, ...picked]) {
    if (!ref) continue;
    const bytes = await readFile(session.absPath(ref)).catch(() => undefined);
    if (bytes && !images.some((b) => b.equals(bytes))) images.push(bytes);
  }
  const now = await session.page.screenshot();
  if (!images.length || !images[images.length - 1]?.equals(now)) images.push(now);
  return images;
}

/**
 * Requests that match an `api-call` expectation.
 * @param {Extract<Expectation, { kind: 'api-call' }>} exp @param {Evidence} evidence
 */
function matchingCalls(exp, evidence) {
  return (evidence.requests ?? []).filter(
    (r) =>
      r.resourceType !== 'document' &&
      (!exp.method || r.method.toUpperCase() === exp.method.toUpperCase()) &&
      textMatches(exp.urlPattern, r.url),
  );
}

/**
 * True when the expectation already held on the start page.
 * @param {Expectation} exp @param {Baseline} base @param {Evidence} evidence
 */
function isVacuous(exp, base, evidence) {
  switch (exp.kind) {
    case 'api-call': {
      if (base.requestCount === undefined) return false;
      const calls = matchingCalls(exp, evidence);
      return (
        calls.length > 0 && calls.every((r) => r.seq <= /** @type {number} */ (base.requestCount))
      );
    }
    case 'url':
      return exp.mode === 'regex'
        ? new RegExp(exp.pattern).test(base.url)
        : base.url.includes(exp.pattern);
    case 'text-visible':
      return base.text.includes(exp.text.toLowerCase());
    case 'selector-visible':
      return base.visibleSelectors.includes(exp.selector);
    default:
      return false; // visual and the error checks are never vacuous
  }
}

/** @param {BrowserSession} session @returns {Evidence} */
function emptyEvidence(session) {
  return {
    finalUrl: session.page.url(),
    title: '',
    pageTextExcerpt: '',
    screenshots: [],
    console: [],
    networkFailures: [],
  };
}

/**
 * What is wrong with one screen's theme audit, as short sentences (empty = conforms).
 * @param {import('../core/types.js').ThemeAudit} t
 * @param {{ minScore: number, allowLeaks: boolean, allowHardCoded: boolean }} exp
 */
function themeProblems(t, exp) {
  /** @type {string[]} */
  const out = [];
  for (const th of t.themes) {
    const pct = th.score === null ? null : Math.round(th.score * 100);
    if (th.score !== null && th.score < exp.minScore) {
      const top = th.findings[0];
      out.push(
        `${th.id}: ${pct}% on-theme${top ? ` (${top.kind} ${top.category} ${top.value}${top.examples[0] ? ` in ${top.examples[0].selector}` : ''}${top.declaration?.source ? ` at ${top.declaration.source}` : ''})` : ''}`,
      );
    }
    const hard = th.findings.filter((f) => f.kind === 'hard-coded' || f.kind === 'browser-default');
    if (!exp.allowHardCoded && hard.length && (th.score === null || th.score >= exp.minScore)) {
      const f = /** @type {import('../core/types.js').ThemeFinding} */ (hard[0]);
      out.push(
        `${th.id}: ${hard.length} value(s) bypass the theme (${f.kind} ${f.category} ${f.value}${f.declaration?.selector ? ` in ${f.declaration.selector}` : f.examples[0] ? ` in ${f.examples[0].selector}` : ''}${f.nearest?.token ? `, nearest ${f.nearest.token}` : ''})`,
      );
    }
    if (!exp.allowLeaks && th.leaks.length)
      out.push(
        `${th.id}: ${th.leaks.length} surface(s) ignore the theme (e.g. ${th.leaks[0]?.value} ${th.leaks[0]?.selector})`,
      );
  }
  return out;
}
