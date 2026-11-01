import { cutOffBy, runInsights } from './insights.js';

/**
 * Comparing runs of the same app: what got fixed, what broke, what is new, and what it cost. Works on digests,
 * a few kilobytes per run, so a history of many runs stays cheap to read. Pure, like insights.js: the UI, the
 * API and the tests all use it.
 *
 * @import { RunReport } from '../core/types.js'
 */

/**
 * @typedef {object} TestDigest
 * @property {string} id
 * @property {string} title
 * @property {'pass' | 'fail' | 'error'} status
 * @property {string} mode  agent | replay | healed | deterministic
 * @property {number} durationMs
 * @property {number} tokens  browser-agent tokens
 * @property {string} [reason]  why it did not pass, in plain words
 * @property {boolean} [cutOff]  the run was stopped before this test finished: says nothing about the app
 */
/**
 * @typedef {object} RunDigest  What a comparison needs from a run, without its evidence.
 * @property {string} runId
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {string} targetUrl
 * @property {string} [suite]
 * @property {boolean} [stopped]
 * @property {{ total: number, passed: number, failed: number, errored: number, tokens: number, durationMs: number }} totals
 * @property {TestDigest[]} tests
 * @property {string[]} problems  titles of the high and medium findings
 * @property {string} headline
 */
/**
 * @typedef {object} TestChange
 * @property {string} id
 * @property {string} title
 * @property {'fixed' | 'broke' | 'still-failing' | 'new' | 'removed' | 'passing' | 'not-finished'} change
 *   not-finished: this run was stopped before the test finished, so there is nothing to compare
 * @property {TestDigest} [now]
 * @property {TestDigest} [before]
 */
/**
 * @typedef {object} RunComparison
 * @property {string} sentence  e.g. "2 fixed, 1 newly failing since the run on 31 Oct"
 * @property {'better' | 'worse' | 'mixed' | 'same'} trend
 * @property {TestChange[]} tests  changes first (broke, fixed, still failing, new, removed), then passing
 * @property {{ fixed: number, broke: number, stillFailing: number, added: number, removed: number, notFinished: number }} counts
 * @property {{ newProblems: string[], resolvedProblems: string[] }} problems
 * @property {{ durationMs: number, tokens: number, nowReplayed: number }} delta
 *   time and agent tokens (now minus before); nowReplayed = tests the agent ran before that now replay for free
 */

/** @param {RunReport} report @param {string} [suite] @returns {RunDigest} */
export function digestOf(report, suite) {
  const insights = runInsights(report);
  const cutOff = cutOffBy(report);
  const s = report.summary;
  return {
    runId: report.runId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    targetUrl: report.targetUrl,
    ...((report.suite ?? suite) ? { suite: report.suite ?? suite } : {}),
    ...(report.stopped || report.results.some(cutOff) ? { stopped: true } : {}),
    totals: {
      total: s.total,
      passed: s.passed,
      failed: s.failed,
      errored: s.errored,
      tokens:
        s.inputTokens +
        s.outputTokens +
        (s.overhead?.inputTokens ?? 0) +
        (s.overhead?.outputTokens ?? 0),
      durationMs: Math.max(0, Date.parse(report.finishedAt) - Date.parse(report.startedAt)) || 0,
    },
    tests: report.results.map((r) => ({
      id: r.test.id,
      title: r.test.title,
      status: r.verdict.status,
      mode: r.mode,
      durationMs: r.durationMs,
      tokens: (r.llmUsage?.inputTokens ?? 0) + (r.llmUsage?.outputTokens ?? 0),
      // in plain words ("Stuck on Checkout step one: Last Name is required"), not the judge's raw checks
      ...(cutOff(r)
        ? { cutOff: true, reason: 'Not finished: the run was stopped' }
        : r.verdict.status !== 'pass'
          ? { reason: (insights.tests[r.test.id]?.outcome || r.verdict.reason).slice(0, 300) }
          : {}),
    })),
    problems: insights.findings
      .filter((f) => f.severity === 'high' || f.severity === 'medium')
      .map((f) => f.title),
    headline: insights.headline,
  };
}

/** Same app: same origin and path, ignoring a trailing slash and the hash. @param {string} url */
export const appKey = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
};

/**
 * The run to compare with: the latest earlier finished run on the same app, with the same suite (or neither has
 * one). Failing that, the latest earlier run of the same app with another suite or none: a suite saved from a run
 * keeps that run's test ids, so the two still line up. Stopped runs only count when nothing else exists, since
 * their missing tests are not real changes.
 * @param {RunDigest} current @param {RunDigest[]} all
 */
export function previousOf(current, all) {
  const app = all
    .filter(
      (d) =>
        d.runId !== current.runId &&
        d.startedAt < current.startedAt &&
        appKey(d.targetUrl) === appKey(current.targetUrl),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const sameSuite = app.filter((d) => (d.suite ?? '') === (current.suite ?? ''));
  const pick = (/** @type {RunDigest[]} */ ds) => ds.find((d) => !d.stopped) ?? ds[0];
  return pick(sameSuite) ?? pick(app) ?? null;
}

/** Whether two runs ran different suites (or one ran a suite and the other a plan). @param {RunDigest} a @param {RunDigest} b */
export const otherSuite = (a, b) => (a.suite ?? '') !== (b.suite ?? '');

const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const ORDER = ['broke', 'fixed', 'still-failing', 'new', 'removed', 'not-finished', 'passing'];

/**
 * @param {RunDigest} now @param {RunDigest} before
 * @returns {RunComparison}
 */
export function compareRuns(now, before) {
  // the same test in both runs: by id, else by title (a re-planned test can get a new id). A test the earlier
  // run's stop cut off has no result to compare with, so it counts as not in that run.
  const was = before.tests.filter((t) => !t.cutOff);
  const byId = new Map(was.map((t) => [t.id, t]));
  const byTitle = new Map(was.map((t) => [norm(t.title), t]));
  const matched = new Set();
  /** @type {TestChange[]} */
  const tests = [];
  for (const t of now.tests) {
    const prev = byId.get(t.id) ?? byTitle.get(norm(t.title));
    if (prev) matched.add(prev.id);
    const ok = t.status === 'pass';
    const wasOk = prev?.status === 'pass';
    tests.push({
      id: t.id,
      title: t.title,
      change: t.cutOff
        ? 'not-finished'
        : !prev
          ? 'new'
          : ok && !wasOk
            ? 'fixed'
            : !ok && wasOk
              ? 'broke'
              : ok
                ? 'passing'
                : 'still-failing',
      now: t,
      ...(prev ? { before: prev } : {}),
    });
  }
  for (const t of was)
    if (!matched.has(t.id)) tests.push({ id: t.id, title: t.title, change: 'removed', before: t });
  tests.sort((a, b) => ORDER.indexOf(a.change) - ORDER.indexOf(b.change));

  const count = (/** @type {TestChange['change']} */ c) =>
    tests.filter((t) => t.change === c).length;
  const counts = {
    fixed: count('fixed'),
    broke: count('broke'),
    stillFailing: count('still-failing'),
    added: count('new'),
    removed: count('removed'),
    notFinished: count('not-finished'),
  };
  const hadProblem = new Set(before.problems);
  const hasProblem = new Set(now.problems);
  const problems = {
    newProblems: now.problems.filter((p) => !hadProblem.has(p)),
    resolvedProblems: before.problems.filter((p) => !hasProblem.has(p)),
  };
  const nowReplayed = tests.filter(
    (t) =>
      t.before?.mode === 'agent' && (t.now?.mode === 'replay' || t.now?.mode === 'deterministic'),
  ).length;

  const parts = [
    counts.broke && `${counts.broke} newly failing`,
    counts.fixed && `${counts.fixed} fixed`,
    counts.stillFailing && `${counts.stillFailing} still failing`,
    counts.added && `${counts.added} new`,
    counts.removed && `${counts.removed} no longer run`,
    counts.notFinished && `${counts.notFinished} not finished (run stopped)`,
  ].filter(Boolean);
  const trend =
    counts.broke && counts.fixed
      ? 'mixed'
      : counts.broke
        ? 'worse'
        : counts.fixed
          ? 'better'
          : 'same';
  return {
    sentence: parts.length ? parts.join(', ') : 'No test changed its result',
    trend,
    tests,
    counts,
    problems,
    delta: {
      durationMs: now.totals.durationMs - before.totals.durationMs,
      tokens: now.totals.tokens - before.totals.tokens,
      nowReplayed,
    },
  };
}
