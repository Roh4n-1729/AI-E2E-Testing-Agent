import { z } from 'zod';

export const ConfigSchema = z.object({
  /** "provider/model", e.g. anthropic/claude-haiku-4-5 or openai/gpt-4.1-mini */
  model: z.string().min(1).default('anthropic/claude-haiku-4-5'),
  /**
   * Optional stronger models for the two low-volume, high-leverage calls. The browser agent makes
   * dozens of calls per test, the planner one per run and the visual judge one per visual check, so
   * a bigger model here buys most of the accuracy for little cost. Default: same as `model`.
   */
  plannerModel: z.string().min(1).optional(),
  judgeModel: z.string().min(1).optional(),
  headless: z.boolean().default(true),
  outDir: z.string().default('.aie2e'),
  maxSteps: z.number().int().positive().default(20),
  /**
   * Claude adaptive-thinking effort for the browser agent (only honoured for models Stagehand
   * knows as adaptive-capable). Keep "none": Stagehand's agent loop edits earlier messages, which
   * invalidates Anthropic's thinking-block signatures. Models that think by default and are
   * unknown to Stagehand 3.7.3 (e.g. claude-haiku-5-5) hit that bug, so default to haiku-4-5.
   */
  agentThinkingEffort: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  /** Draw a visible cursor and click ripple in the page so runs can be watched (and appear in screenshots). */
  showCursor: z.boolean().default(true),
  /** Tests run in parallel, each in its own Chromium. */
  concurrency: z.number().int().positive().default(1),
  /** Max tests the LLM planner may generate (a smoke test is always added on top). */
  maxTests: z.number().int().positive().default(5),
  navTimeoutMs: z.number().int().positive().default(30_000),
  viewport: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .prefault({ width: 1280, height: 800 }),
  /** Explicit Chrome/Chromium binary. Falls back to Playwright's Chromium, then system Chrome. */
  chromePath: z.string().optional(),
  /** Extra Chromium flags, e.g. --no-sandbox inside containers/CI running as root. */
  chromeArgs: z.array(z.string()).default([]),
  /**
   * Keep Chrome's own sandbox on Linux for the agent's browser. Off by default, like Playwright: CI runners
   * (Ubuntu 24+ AppArmor) and containers running as root cannot start a sandboxed Chrome at all.
   */
  chromeSandbox: z.boolean().default(false),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
  crawl: z
    .object({
      maxPages: z.number().int().positive().default(8),
      maxDepth: z.number().int().nonnegative().default(2),
    })
    .prefault({}),
  /**
   * Quality audits (Core Web Vitals, accessibility, API health) run on every test. `gate` decides what
   * they do to the verdict: off = not collected for judging, warn = reported but advisory, fail = a
   * breach fails the test. Budgets default to Google's "poor" thresholds, i.e. only clear problems trip.
   */
  /**
   * Visual regression: screenshots compared with approved baselines (per test, per replay step, per theme).
   * gate: off = no captures; warn = differences are shown for review; fail = a difference fails the test.
   */
  visual: z
    .object({
      gate: z.enum(['off', 'warn', 'fail']).default('warn'),
      /** share of pixels that may differ before a screenshot counts as changed */
      maxDiffRatio: z.number().min(0).max(1).default(0.001),
      /**
       * pixelmatch colour tolerance per pixel (0 = exact, 1 = anything). Strict on purpose: a light card
       * on a white page differs by only ~0.03, and one machine renders the same page identically
       * (anti-aliased edges are ignored anyway). Raise it (0.1-0.2) for baselines shared across machines.
       */
      threshold: z.number().min(0).max(1).default(0.02),
      /** where approved baselines live; default <outDir>/baselines. Point it into the repo to commit them. */
      dir: z.string().optional(),
      /** accept every screenshot of a passing test as the new baseline (--update-baselines) */
      update: z.boolean().default(false),
      /**
       * Save screenshots that have no baseline yet as the baseline when the test passes (default). The
       * evaluation turns this off for runs with a seeded bug: a test can pass with the bug in it, and its
       * screenshots must never become the approved look.
       */
      saveNew: z.boolean().default(true),
      /**
       * Hide live regions (toasts, status lines, alerts: role=status|alert|log|timer, aria-live) in the
       * comparison screenshots. They come and go with timing, not design; their text is still evidence
       * (transient messages). Turn off for apps that put whole sections in a live region.
       */
      hideLiveRegions: z.boolean().default(true),
    })
    .prefault({}),
  quality: z
    .object({
      gate: z.enum(['off', 'warn', 'fail']).default('warn'),
      a11y: z.boolean().default(true),
      a11yMinImpact: z.enum(['minor', 'moderate', 'serious', 'critical']).default('serious'),
      /** Theme conformance: the page uses the themes its own build ships, in every theme. */
      theme: z.boolean().default(true),
      themeMinScore: z.number().min(0).max(1).default(0.9),
      /** Screens audited per test besides the final one (start, after steps). 0 = final state only. */
      themeStates: z.number().int().min(0).max(20).default(4),
      budgets: z
        .object({
          lcpMs: z.number().positive().default(4000),
          cls: z.number().positive().default(0.25),
          inpMs: z.number().positive().default(500),
          fcpMs: z.number().positive().default(3000),
          ttfbMs: z.number().positive().default(1800),
        })
        .prefault({}),
      /** fetch/XHR calls slower than this are flagged in the report. */
      slowApiMs: z.number().positive().default(3000),
    })
    .prefault({}),
  /**
   * Known third-party noise the guards ignore (regexes on the URL / console text): analytics, error
   * reporters, font CDNs. Ignored requests still appear in the evidence; they just do not fail a test.
   * Also from a suite's "ignore" and AIE2E_IGNORE_NETWORK / AIE2E_IGNORE_CONSOLE (comma-separated).
   */
  judge: z
    .object({
      ignoreConsolePatterns: z.array(z.string()).default([]),
      ignoreNetworkPatterns: z.array(z.string()).default(['favicon\\.ico']),
    })
    .prefault({}),
});

/** @typedef {z.infer<typeof ConfigSchema>} Config */
/** @typedef {z.input<typeof ConfigSchema>} ConfigInput */

/** @param {string | undefined} v */
const bool = (v) => (v === undefined ? undefined : ['1', 'true', 'yes'].includes(v.toLowerCase()));
/** @param {string | undefined} v comma-separated list */
const list = (v) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
/** @param {string | undefined} v */
const int = (v) => (v === undefined || v === '' ? undefined : Number(v));

/**
 * Precedence: explicit overrides (CLI flags) > environment > defaults.
 * @param {Partial<ConfigInput>} [overrides]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Config}
 */
export function loadConfig(overrides = {}, env = process.env) {
  /** @param {object} o */
  const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  /** @type {Partial<ConfigInput>} */
  const fromEnv = {
    model: env.AIE2E_MODEL || undefined,
    plannerModel: env.AIE2E_PLANNER_MODEL || undefined,
    judgeModel: env.AIE2E_JUDGE_MODEL || undefined,
    headless: bool(env.AIE2E_HEADLESS),
    outDir: env.AIE2E_OUT_DIR || undefined,
    maxSteps: int(env.AIE2E_MAX_STEPS),
    agentThinkingEffort: /** @type {ConfigInput['agentThinkingEffort']} */ (
      env.AIE2E_THINKING_EFFORT || undefined
    ),
    showCursor: bool(env.AIE2E_SHOW_CURSOR),
    concurrency: int(env.AIE2E_CONCURRENCY),
    chromePath: env.AIE2E_CHROME_PATH || undefined,
    chromeArgs: env.AIE2E_CHROME_ARGS ? env.AIE2E_CHROME_ARGS.split(' ') : undefined,
    chromeSandbox: bool(env.AIE2E_CHROME_SANDBOX),
    logLevel: /** @type {ConfigInput['logLevel']} */ (env.AIE2E_LOG_LEVEL || undefined),
    visual:
      env.AIE2E_VISUAL_GATE || env.AIE2E_BASELINES_DIR
        ? defined({
            gate: /** @type {'off' | 'warn' | 'fail' | undefined} */ (env.AIE2E_VISUAL_GATE),
            dir: env.AIE2E_BASELINES_DIR || undefined,
          })
        : undefined,
    quality:
      env.AIE2E_QUALITY_GATE || env.AIE2E_THEME_STATES
        ? defined({
            gate: /** @type {'off' | 'warn' | 'fail' | undefined} */ (env.AIE2E_QUALITY_GATE),
            themeStates: env.AIE2E_THEME_STATES ? Number(env.AIE2E_THEME_STATES) : undefined,
          })
        : undefined,
    judge:
      env.AIE2E_IGNORE_NETWORK || env.AIE2E_IGNORE_CONSOLE
        ? defined({
            ignoreNetworkPatterns: env.AIE2E_IGNORE_NETWORK
              ? ['favicon\\.ico', ...(list(env.AIE2E_IGNORE_NETWORK) ?? [])]
              : undefined,
            ignoreConsolePatterns: list(env.AIE2E_IGNORE_CONSOLE),
          })
        : undefined,
  };
  const merged = { ...defined(fromEnv), ...defined(overrides) };
  // nested groups merge, so a CLI flag (--visual fail) keeps the env's settings (AIE2E_BASELINES_DIR)
  for (const k of /** @type {const} */ (['visual', 'quality', 'judge']))
    if (fromEnv[k] && overrides[k]) merged[k] = { ...fromEnv[k], ...defined(overrides[k]) };
  return ConfigSchema.parse(merged);
}

/**
 * Env var the AI SDK / Stagehand will look for, by model provider prefix.
 * @param {string} model
 */
export function apiKeyEnvFor(model) {
  const provider = model.split('/')[0] ?? '';
  /** @type {Record<string, string>} */
  const map = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  };
  return map[provider];
}
