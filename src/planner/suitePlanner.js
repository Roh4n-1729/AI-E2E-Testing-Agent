import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ExpectationSchema, RecordedStepSchema, TestCaseSchema } from '../core/types.js';
import { testFingerprint } from '../storage/recordStore.js';
import { slugify } from '../util/misc.js';
import { AuthSchema } from '../auth/login.js';

/**
 * @import { Planner, RecordStore } from '../core/ports.js'
 * @import { Recording, SiteMap, Target, TestCase } from '../core/types.js'
 */

/**
 * A committed test suite: tests you keep in your repo, review in PRs and run in CI.
 * Each test may carry `steps` (recorded or hand-written Playwright steps). Tests with steps replay
 * with no LLM; tests without steps are done by the agent and recorded after they pass.
 * `startUrl` may be relative ("/cart"): it is resolved against the URL being tested, so one suite
 * runs against local, staging and production.
 */
export const SuiteSchema = z.object({
  description: z.string().optional(),
  /** the app this suite usually runs against (the UI's default); the CLI's URL argument wins */
  url: z.url({ protocol: /^https?$/ }).optional(),
  /** check the theme against another product's themes (cross-product conformance) */
  themeFrom: z.url({ protocol: /^https?$/ }).optional(),
  /** log in before the tests (credentials come from .env, never from this file) */
  auth: AuthSchema.optional(),
  /**
   * Known third-party noise this app makes (regexes): failed requests and console errors that match do
   * not fail the no-network-failures / no-console-errors guards. They still show in the evidence.
   */
  ignore: z
    .object({
      network: z.array(z.string()).default([]),
      console: z.array(z.string()).default([]),
    })
    .optional(),
  tests: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .optional(),
        title: z.string().min(1),
        goal: z.string().default(''),
        startUrl: z.string().default('/'),
        expectations: z.array(ExpectationSchema).default([]),
        steps: z.array(RecordedStepSchema.omit({ index: true })).optional(),
        maxSteps: z.number().int().positive().optional(),
        tags: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

/** @typedef {z.input<typeof SuiteSchema>} SuiteInput */

/** @param {string} file */
export async function loadSuite(file) {
  return SuiteSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

const GUARDS = /** @type {const} */ (['no-console-errors', 'no-network-failures']);

/** @implements {Planner} */
export class SuitePlanner {
  /** @type {Map<string, Recording>} recordings built from the suite's steps, keyed by test id */
  seeds = new Map();

  /** @param {z.infer<typeof SuiteSchema>} suite */
  constructor(suite) {
    this.suite = suite;
  }

  /** @param {Target} target @param {SiteMap} _siteMap @returns {Promise<TestCase[]>} */
  async plan(target, _siteMap) {
    /** @type {TestCase[]} */
    const tests = [];
    const ids = new Set();
    for (const t of this.suite.tests) {
      let id = t.id ?? slugify(t.title);
      for (let n = 2; ids.has(id); n++) id = `${slugify(t.title, 40)}-${n}`;
      ids.add(id);
      const expectations = [...t.expectations];
      // the same guards every planned test gets, unless the suite already lists them
      for (const kind of GUARDS)
        if (!expectations.some((e) => e.kind === kind)) expectations.push({ kind });
      const test = TestCaseSchema.parse({
        id,
        title: t.title,
        goal: t.goal,
        startUrl: new URL(t.startUrl, target.url).toString(),
        expectations,
        maxSteps: t.maxSteps,
        tags: t.tags,
        origin: 'suite',
      });
      tests.push(test);
      if (t.steps?.length && test.goal) {
        this.seeds.set(id, {
          schemaVersion: 1,
          testId: id,
          fingerprint: testFingerprint(test),
          recordedAt: 'suite',
          steps: [
            {
              index: 0,
              kind: 'navigate',
              description: `Open ${test.startUrl}`,
              url: test.startUrl,
            },
            ...t.steps.map((s, i) => ({ ...s, index: i + 1 })),
          ],
        });
      }
    }
    return tests;
  }
}

/**
 * Recordings saved by earlier runs first (they include heals), then the suite's own steps.
 * @implements {RecordStore}
 */
export class SeededRecordStore {
  /** @param {RecordStore} inner @param {Map<string, Recording>} seeds */
  constructor(inner, seeds) {
    this.inner = inner;
    this.seeds = seeds;
  }
  /** @param {string} testId */
  async load(testId) {
    return (await this.inner.load(testId)) ?? this.seeds.get(testId) ?? null;
  }
  /** @param {Recording} recording */
  save(recording) {
    return this.inner.save(recording);
  }
}

/**
 * Turn a finished run into a committed suite: its tests plus the recorded steps of every test that
 * passed with the agent, with start URLs made relative to the app.
 * @param {import('../core/types.js').RunReport} report
 * @param {(testId: string) => Promise<Recording | null>} loadRecording
 * @returns {Promise<SuiteInput>}
 */
export async function suiteFromRun(report, loadRecording) {
  const origin = new URL(report.targetUrl).origin;
  /** @type {SuiteInput['tests']} */
  const tests = [];
  for (const r of report.results) {
    const rec = await loadRecording(r.test.id);
    const u = new URL(r.test.startUrl);
    tests.push({
      id: r.test.id,
      title: r.test.title,
      goal: r.test.goal,
      startUrl: u.origin === origin ? u.pathname + u.search : r.test.startUrl,
      expectations: r.test.expectations.filter(
        (e) => !GUARDS.includes(/** @type {any} */ (e.kind)),
      ),
      ...(rec && rec.fingerprint === testFingerprint(r.test)
        ? { steps: rec.steps.filter((s) => s.index > 0).map(({ index: _i, ...s }) => s) }
        : {}),
      tags: r.test.tags,
    });
  }
  return { tests };
}
