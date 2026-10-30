import { z } from 'zod';
import { TestCaseSchema } from '../core/types.js';
import { slugify } from '../util/misc.js';
import { StaticPlanner } from './staticPlanner.js';

/**
 * @import { LlmClient, Planner } from '../core/ports.js'
 * @import { Expectation, SiteMap, Target, TestCase } from '../core/types.js'
 * @import { Logger } from '../util/logger.js'
 */

/**
 * What we ask the LLM for. Deliberately flat and fully required (no optionals, no unions)
 * so it works with strict structured-output modes across providers; we map it to the richer
 * internal Expectation type ourselves.
 */
export const PlanSchema = z.object({
  tests: z.array(
    z.object({
      title: z.string().describe('Short name of the user flow'),
      goal: z
        .string()
        .describe('Plain-English instructions an agent can follow starting from the start URL'),
      expectations: z
        .array(
          z.object({
            kind: z.enum([
              'visual',
              'download',
              'text-appeared',
              'text-visible',
              'api-call',
              'url-contains',
              'selector-visible',
            ]),
            value: z
              .string()
              .describe(
                'visual: a yes/no question answered from screenshots of the start, the run and the end. download: expected file extension or name fragment, e.g. ".pptx" (empty string = any file). text-appeared: text of a confirmation/toast/alert that shows briefly. text-visible: exact text that stays on the page. api-call: "METHOD /path" of an endpoint listed in the crawl summary. url-contains: a URL fragment copied from the crawl summary. selector-visible: a test id selector copied from the crawl summary.',
              ),
          }),
        )
        .describe('1 to 3 outcome checks that prove the goal was achieved'),
    }),
  ),
});

const SYSTEM = `You are a senior QA engineer designing end-to-end tests for a web app you can only see through a crawl summary.

Rules:
- Propose distinct, valuable USER FLOWS (navigation, search, forms, content visible after an action), not page-load checks.
- Every goal must be achievable by an agent that starts at the start URL and clicks/types like a real user.
- Ground everything in the crawl summary. Never invent pages, button labels or credentials.
- When a goal fills in a form, write the exact test values into the goal (e.g. name "Ada Lovelace", email "ada@example.com", address "1 Test Street"): the agent types only what it is given. Use obviously fake data, never real people, passwords or card numbers.
- Check the EFFECT of every action in the goal, not only that the last page opened: if a test adds two products, check the cart count that matches (the crawl shows "Cart (0)", so expect "Cart (2)") or ask a visual question about the cart; if the page shows a number the action changes (count, total, quantity), check that number. A goal with three actions and one check on the final URL proves almost nothing.
- Text that is already on the start page proves nothing and is discarded by the judge: product names listed on the home page cannot prove they reached the cart.
- Never guess the wording of a message you have not seen in the crawl (confirmations, thank-you notes, errors). Ask a visual yes/no question about it instead.
- Do NOT plan destructive or irreversible actions (deleting, paying, sending messages, logging out) and do not plan flows that need a login you were not given.
- Each test needs 1 to 3 expectations about the END state, and at least one MUST be false on the start page and true only after the goal succeeds (the judge discards expectations that already hold at the start, and a test with none of those is reported as inconclusive).
  - Never use generic words that are already on the page (button labels, the app name, "slide", "edit", "export").
  - Prefer a visual yes/no question describing the end state (e.g. "Is a generated slide deck with several slides shown?"), or a url-contains on a PATH segment that only appears after the action. Never match the hostname.
  - A visual question must test ONE simple observable fact about a single browser-viewport screenshot (e.g. "Is a slideshow or presentation view shown?"). Never stack conditions ("full-screen AND with navigation controls") and never require UI details you have not seen in the crawl.
  - Use text-visible only for specific content that will exist only after the action.
  - selector-visible only with a test id selector copied exactly from "stable test ids" (e.g. [data-testid="slide-2"]); it is the strongest evidence when available.
- Follow "developer hints" from the crawl: the app's own developers wrote them for testers.
- Keep each test fast and cheap: if the app offers a sample, template or demo that reaches the needed state, have the goal use it, unless the test is about creating that state.
- When a test checks that something CHANGED (theme applied, slide added, item removed), phrase the visual question as a change ("Did the slide colours change compared with the start?"): the judge compares the first and last screenshots.
- Keep tests independent of each other.`;

/** @param {SiteMap} siteMap */
function summarizeSiteMap(siteMap) {
  return siteMap.pages
    .map((p, i) =>
      [
        `Page ${i + 1}: ${p.url}`,
        `  title: ${p.title || '(none)'}`,
        p.textExcerpt ? `  text: ${p.textExcerpt}` : '',
        p.buttons?.length ? `  buttons: ${p.buttons.join(' | ')}` : '',
        p.forms ? `  forms: ${p.forms}` : '',
        p.apiCalls?.length ? `  API calls seen on load: ${p.apiCalls.join(' | ')}` : '',
        p.testIds?.length ? `  stable test ids: ${p.testIds.join(' | ')}` : '',
        p.hints?.length ? `  developer hints: ${p.hints.join(' | ')}` : '',
        p.links.length ? `  links to: ${p.links.slice(0, 12).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

/**
 * Map the planner's flat expectation to the internal type, or null when it is not grounded in the
 * crawl. Guessed URL fragments and endpoints are the #1 source of false failures, so they are dropped.
 * @param {{ kind: string, value: string }} e @param {SiteMap} siteMap
 * @returns {Expectation | null}
 */
export function toExpectation(e, siteMap) {
  const value = e.value.trim();
  switch (e.kind) {
    case 'url-contains': {
      const known = siteMap.pages.flatMap((p) => [p.url, ...p.links]);
      return value && known.some((u) => u.includes(value))
        ? { kind: 'url', pattern: value, mode: 'includes' }
        : null;
    }
    case 'api-call': {
      const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i.exec(value);
      const path = m?.[2] ?? value;
      const known = siteMap.pages.flatMap((p) => p.apiCalls ?? []);
      if (!path || !known.some((c) => c.includes(path))) return null;
      return { kind: 'api-call', urlPattern: path, method: m?.[1]?.toUpperCase() };
    }
    case 'download':
      return { kind: 'download', filenamePattern: value || undefined };
    case 'text-appeared':
      return value ? { kind: 'text-appeared', text: value } : null;
    case 'selector-visible': {
      // only selectors the app really exposes (test ids seen by the crawler)
      const known = siteMap.pages.flatMap((p) => p.testIds ?? []);
      return value && known.some((t) => t.startsWith(value))
        ? { kind: 'selector-visible', selector: value }
        : null;
    }
    case 'visual':
      return value ? { kind: 'visual', question: value } : null;
    default:
      return value ? { kind: 'text-visible', text: value } : null;
  }
}

/** @param {string} s */
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** the same text with every number replaced, so "Cart (3)" matches the "Cart (0)" the crawler saw */
const shape = (/** @type {string} */ s) => norm(s).replace(/\d+(?:[.,]\d+)*/g, '#');
const SUCCESS_QUESTION =
  'After the action, does the page show that it succeeded (a confirmation, an updated count or new content)?';

/**
 * Deterministic review of planned outcome checks against what the crawler actually saw. The judge would
 * discard a check that already holds on the start page, and a text the crawl never showed is a guess.
 * Returns the problems (for one revision round with the planner) and a repaired list to fall back on:
 * start-page checks dropped, guessed texts turned into a yes/no question about the screenshots.
 * @param {Expectation[]} exps @param {SiteMap} siteMap @param {string} startUrl
 * @returns {{ issues: string[], repaired: Expectation[] }}
 */
export function reviewExpectations(exps, siteMap, startUrl) {
  const strip = (/** @type {string} */ u) => u.replace(/\/+$/, '');
  const start = siteMap.pages.find((p) => strip(p.url) === strip(startUrl)) ?? siteMap.pages[0];
  const startText = norm(
    [start?.title, start?.textExcerpt, ...(start?.buttons ?? [])].filter(Boolean).join(' '),
  );
  const seen = shape(
    siteMap.pages
      .flatMap((p) => [p.title, p.textExcerpt, ...(p.buttons ?? [])])
      .filter(Boolean)
      .join(' | '),
  );
  /** @type {string[]} */
  const issues = [];
  /** @type {Expectation[]} */
  const repaired = [];
  for (const e of exps) {
    if (e.kind === 'text-visible' || e.kind === 'text-appeared') {
      if (startText.includes(norm(e.text))) {
        issues.push(`"${e.text}" is already on the start page, so it proves nothing`);
        continue;
      }
      if (!seen.includes(shape(e.text))) {
        issues.push(`"${e.text}" appears nowhere in the crawl: that wording is a guess`);
        if (!repaired.some((r) => r.kind === 'visual'))
          repaired.push({ kind: 'visual', question: SUCCESS_QUESTION });
        continue;
      }
    }
    if (e.kind === 'url' && e.mode === 'includes' && startUrl.includes(e.pattern)) {
      issues.push(`the URL check "${e.pattern}" is already true at the start URL`);
      continue;
    }
    repaired.push(e);
  }
  return { issues, repaired };
}

/**
 * Generates tests from the site map and description. A deterministic smoke test is always
 * included first (cheap, no LLM, catches a broken page even if planning is mediocre).
 * Planner failures are surfaced as errors rather than silently degrading.
 * @implements {Planner}
 */
export class LlmPlanner {
  /**
   * @param {LlmClient} llm
   * @param {{ maxTests: number }} opts
   * @param {Logger} logger
   */
  constructor(llm, opts, logger) {
    this.llm = llm;
    this.opts = opts;
    this.logger = logger;
  }

  /** @param {Target} target @param {SiteMap} siteMap @returns {Promise<TestCase[]>} */
  async plan(target, siteMap) {
    const [smoke] = await new StaticPlanner().plan({ url: target.url }, siteMap);
    const prompt = [
      `Start URL: ${target.url}`,
      target.description ? `App description: ${target.description}` : '',
      `Propose at most ${this.opts.maxTests} tests.`,
      '',
      'Crawl summary:',
      summarizeSiteMap(siteMap),
    ]
      .filter((l) => l !== '')
      .join('\n');

    let plan = await this.llm.generateObject({ schema: PlanSchema, system: SYSTEM, prompt });
    let review = this.#build(plan.tests, target, siteMap, smoke);

    // One revision round: the planner gets the reviewer's findings and returns the whole plan again.
    if (review.issues.length) {
      this.logger.info(
        `planner: ${review.issues.length} weak check(s) found, asking the planner to fix them`,
      );
      const feedback = [
        prompt,
        '',
        'A reviewer checked your previous plan against the crawl and found these problems:',
        ...review.issues.map((i) => `- ${i}`),
        'Return the complete plan again with every problem fixed. Keep the good tests as they are.',
      ].join('\n');
      try {
        plan = await this.llm.generateObject({
          schema: PlanSchema,
          system: SYSTEM,
          prompt: feedback,
        });
        review = this.#build(plan.tests, target, siteMap, smoke);
      } catch (e) {
        this.logger.warn(
          `planner: revision failed (${/** @type {Error} */ (e).message}); repairing the first plan`,
        );
      }
      for (const i of review.issues) this.logger.warn(`planner: repaired a weak check: ${i}`);
    }
    return review.tests;
  }

  /**
   * Turn planned tests into TestCases: ground each check in the crawl, then review it. Tests use the
   * repaired checks; `issues` says what was wrong, for the revision round.
   * @param {z.infer<typeof PlanSchema>['tests']} planned @param {Target} target @param {SiteMap} siteMap
   * @param {TestCase | undefined} smoke
   */
  #build(planned, target, siteMap, smoke) {
    /** @type {TestCase[]} */
    const tests = smoke ? [smoke] : [];
    /** @type {string[]} */
    const issues = [];
    const ids = new Set(tests.map((t) => t.id));
    for (const raw of planned.slice(0, this.opts.maxTests)) {
      let id = slugify(raw.title);
      for (let n = 2; ids.has(id); n++) id = `${slugify(raw.title, 40)}-${n}`;
      /** @type {Expectation[]} */
      const grounded = [];
      for (const e of raw.expectations) {
        const exp = toExpectation(e, siteMap);
        if (exp) grounded.push(exp);
        else
          this.logger.warn(
            `planner: dropped ungrounded expectation (${e.kind}: "${e.value}") in "${raw.title}"`,
          );
      }
      // A test without a goal checks the start page itself (no action), so start-page text is its point.
      const review = raw.goal.trim()
        ? reviewExpectations(grounded, siteMap, target.url)
        : { issues: [], repaired: grounded };
      for (const i of review.issues) issues.push(`In "${raw.title}": ${i}`);
      const outcome = review.repaired;
      if (outcome.length === 0)
        outcome.push({
          kind: 'visual',
          question: `Does the page now show the result of this action: ${raw.goal}`,
        });
      const parsed = TestCaseSchema.safeParse({
        id,
        title: raw.title,
        goal: raw.goal,
        startUrl: target.url,
        expectations: [...outcome, { kind: 'no-console-errors' }, { kind: 'no-network-failures' }],
      });
      if (!parsed.success) {
        this.logger.warn(`planner: dropped invalid test "${raw.title}": ${parsed.error.message}`);
        continue;
      }
      ids.add(id);
      tests.push(parsed.data);
    }
    return { tests, issues };
  }
}
