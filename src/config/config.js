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
  quality: z
    .object({
      gate: z.enum(['off', 'warn', 'fail']).default('warn'),
      a11y: z.boolean().default(true),
      a11yMinImpact: z.enum(['minor', 'moderate', 'serious', 'critical']).default('serious'),
      /** Theme conformance: the page uses the themes its own build ships, in every theme. */
      theme: z.boolean().default(true),
      themeMinScore: z.number().min(0).max(1).default(0.9),
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
/** @param {string | undefined} v */
const int = (v) => (v === undefined || v === '' ? undefined : Number(v));

/**
 * Precedence: explicit overrides (CLI flags) > environment > defaults.
 * @param {Partial<ConfigInput>} [overrides]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Config}
 */
export function loadConfig(overrides = {}, env = process.env) {
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
    logLevel: /** @type {ConfigInput['logLevel']} */ (env.AIE2E_LOG_LEVEL || undefined),
    quality: env.AIE2E_QUALITY_GATE
      ? { gate: /** @type {'off' | 'warn' | 'fail'} */ (env.AIE2E_QUALITY_GATE) }
      : undefined,
  };
  /** @param {object} o */
  const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return ConfigSchema.parse({ ...defined(fromEnv), ...defined(overrides) });
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
