import { z } from 'zod';

/**
 * Domain model. Zod schemas are the source of truth for anything validated or persisted;
 * the JSDoc typedefs below power editor hints and `npm run check` (tsc --checkJs).
 */

// ---------- Expectations (what the judge verifies) ----------
export const ExpectationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    pattern: z.string(),
    mode: z.enum(['includes', 'regex']).default('includes'),
  }),
  z.object({ kind: z.literal('text-visible'), text: z.string() }),
  z.object({ kind: z.literal('selector-visible'), selector: z.string() }),
  z.object({ kind: z.literal('no-console-errors') }),
  z.object({ kind: z.literal('no-network-failures') }),
  /** An LLM answers `question` from the harness screenshot, never from the agent's words. */
  z.object({ kind: z.literal('visual'), question: z.string() }),
  /** The page made a matching fetch/XHR call (observed by the harness, not reported by the agent). */
  z.object({
    kind: z.literal('api-call'),
    /** Substring of the request URL, or a regex. */
    urlPattern: z.string(),
    method: z.string().optional(),
    /** Exact status; omitted = any 2xx/3xx. */
    status: z.number().int().optional(),
    maxDurationMs: z.number().positive().optional(),
  }),
  /** The browser started a file download (optionally with a matching file name). */
  z.object({ kind: z.literal('download'), filenamePattern: z.string().optional() }),
  /** Text that appeared in a toast / live region / alert at ANY moment, even if it is gone by the end. */
  z.object({ kind: z.literal('text-appeared'), text: z.string() }),
  /** Core Web Vitals budgets (any omitted metric is not checked). */
  z.object({
    kind: z.literal('web-vitals'),
    lcpMs: z.number().positive().optional(),
    cls: z.number().positive().optional(),
    inpMs: z.number().positive().optional(),
    fcpMs: z.number().positive().optional(),
    ttfbMs: z.number().positive().optional(),
  }),
  /**
   * The page uses the themes its own build ships (CSS variables) in every theme: at least `minScore` of the
   * checked colours/radii/fonts come from theme tokens, and no surface ignores the theme switch.
   */
  z.object({
    kind: z.literal('theme-conformance'),
    minScore: z.number().min(0).max(1).default(0.9),
    allowLeaks: z.boolean().default(false),
    /** false = any value set by a CSS rule without a theme variable is a problem, whatever the score */
    allowHardCoded: z.boolean().default(false),
  }),
  /**
   * Screenshots look like their approved baselines (the final screen, each replayed step, each theme).
   * Areas marked data-aie2e-mask are blanked first. Auto-added under the visual gate.
   */
  z.object({
    kind: z.literal('visual-baseline'),
    maxDiffRatio: z.number().min(0).max(1).default(0.001),
  }),
  /** axe-core found no accessibility violations at or above `minImpact` on the final page. */
  z.object({
    kind: z.literal('no-a11y-violations'),
    minImpact: z.enum(['minor', 'moderate', 'serious', 'critical']).default('serious'),
  }),
]);

// ---------- Test cases ----------
export const TestCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase slug'),
  title: z.string().min(1),
  /** Natural-language goal. Empty string = deterministic smoke test (no LLM). */
  goal: z.string(),
  startUrl: z.url(),
  expectations: z.array(ExpectationSchema),
  maxSteps: z.number().int().positive().optional(),
  tags: z.array(z.string()).default([]),
});

// ---------- Recorded (replayable) steps: the Saturday contract ----------
export const RecordedStepSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(['navigate', 'act', 'back', 'wait', 'mouse']),
  /** Human description, also the instruction handed back to the agent when healing. */
  description: z.string(),
  url: z.string().optional(),
  selector: z.string().optional(),
  /** Tried in order when `selector` no longer matches (e.g. the XPath, when `selector` is a test id). */
  fallbackSelectors: z.array(z.string()).optional(),
  method: z.string().optional(),
  /** act/mouse: method arguments. mouse: [xPercent, yPercent] of the viewport. */
  arguments: z.array(z.string()).optional(),
});

export const RecordingSchema = z.object({
  schemaVersion: z.literal(1),
  testId: z.string(),
  /** sha256 of goal + startUrl + expectations. A changed test invalidates its recording. */
  fingerprint: z.string(),
  recordedAt: z.string(),
  steps: z.array(RecordedStepSchema),
});

/**
 * One line of a test's run log: what the agent or the replay did, in order, with the screenshot
 * taken right after it. Built by the harness; shown as the step timeline in reports.
 * @typedef {object} TraceEntry
 * @property {number} index
 * @property {'agent' | 'replay' | 'harness'} source
 * @property {string} tool  e.g. act, goto, hoverAt, ariaTree, click
 * @property {string} description
 * @property {boolean} ok
 * @property {boolean} [observe]  looked at the page without changing it (screenshot, ariaTree, extract, think)
 * @property {string} [screenshot]  path relative to the run dir
 * @property {string} [url]
 * @property {string} ts
 */
/** @typedef {z.infer<typeof ExpectationSchema>} Expectation */
/** @typedef {z.infer<typeof TestCaseSchema>} TestCase */
/** @typedef {z.infer<typeof RecordedStepSchema>} RecordedStep */
/** @typedef {{ completed: RecordedStep[], failed: RecordedStep, baseline: Baseline }} ResumeContext  Where a healing agent picks up after a replay step broke. */
/** @typedef {z.infer<typeof RecordingSchema>} Recording */

// ---------- Evidence & verdicts ----------
/** @typedef {{ type: string, text: string, url?: string, ts: string }} ConsoleEntry */
/** @typedef {{ url: string, method: string, status?: number, failure?: string, ts: string }} NetworkFailure */
/** @typedef {{ label: string, path: string, url: string, source: 'harness' | 'agent' }} ScreenshotRef  path is relative to the run dir */
/** @typedef {{ method: string, url: string, resourceType: string, status?: number, durationMs?: number, bytes?: number, failure?: string, api: boolean, seq: number, ts: string }} RequestRecord */
/** @typedef {{ total: number, failed: number, api: number, transferredBytes: number, byType: Record<string, number>, slowestApi?: { url: string, durationMs: number } }} RequestStats */
/** @typedef {{ filename: string, url: string, savedPath?: string, bytes?: number, error?: string, ts: string }} DownloadRecord */
/** @typedef {{ text: string, url: string, ts: string }} SeenText */
/** @typedef {{ name: 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB', value: number, rating: 'good' | 'needs-improvement' | 'poor' }} VitalMetric */
/** @typedef {{ url: string, metrics: VitalMetric[] }} VitalsRecord  One entry per document the browser loaded. */
/** @typedef {{ id: string, impact: string | null, help: string, helpUrl: string, nodes: number, examples: { target: string, html: string }[] }} A11yViolation */
/** @typedef {{ violations: A11yViolation[], error?: string }} A11yResult */
/**
 * @typedef {object} ThemeFinding  One off-theme value, grouped (e.g. "#2f6fe4 used as background 3 times").
 * @property {'color' | 'background' | 'border' | 'radius' | 'fontSize' | 'fontFamily'} category
 * @property {string} value
 * @property {number} count
 * @property {'hard-coded' | 'browser-default' | 'off-theme' | 'off-reference'} kind  hard-coded = an author rule without var(); browser-default = no author style at all; off-reference = matches no token of the reference product
 * @property {{ token: string, value: string, deltaE?: number }} [nearest]
 * @property {{ value: string, source?: string, selector?: string }} [declaration]  the CSS rule Chrome says produced it
 * @property {{ selector: string, text: string }[]} examples
 * @property {string} [crop]  screenshot of the first element, relative to the run dir
 */
/** @typedef {{ selector: string, text: string, value: string, source?: string }} ThemeLeak  A large surface that keeps the same background in every theme. */
/**
 * @typedef {object} ThemeResult
 * @property {string} id  e.g. light, dark, ocean
 * @property {string} switch  how the theme is activated
 * @property {{ colors: number, lengths: number, fonts: number }} tokens
 * @property {number} checked
 * @property {number} onTheme
 * @property {number | null} score  onTheme / checked; null when the theme defines nothing checkable
 * @property {Record<string, { checked: number, on: number }>} categories
 * @property {ThemeFinding[]} findings
 * @property {ThemeLeak[]} leaks
 * @property {number} contrastIssues  elements failing WCAG AA contrast in this theme
 * @property {string} [screenshot]
 * @property {InventoryEntry[]} [inventory]  how buttons, links, inputs, headings and named components look
 */
/**
 * @typedef {object} InventoryEntry  One distinct look of one kind of element in one theme.
 * @property {string} kind  button | link | input | h1..h6 | component
 * @property {string} [component]  the app's own name for it (data-aie2e-component)
 * @property {string} [variant]  disabled, selected, pressed, current, expanded: compared separately
 * @property {Record<string, string>} style  colours as hex; color, background, border, radius, fontSize, fontWeight, fontFamily, padding
 * @property {number} count
 * @property {{ selector: string, text: string }} example
 */
/**
 * @typedef {object} ThemeState  The theme audit of one screen a test reached.
 * @property {string} key  state fingerprint (route, overlays, landmarks, test ids)
 * @property {string} testId
 * @property {string} label  e.g. "start", "after step 3", "final"
 * @property {string} url
 * @property {number} [step]
 * @property {{ testId: string, label: string }} [reusedFrom]  the run already audited this screen there
 * @property {ThemeAudit} audit
 */
/** @typedef {{ themes: ThemeResult[], tokenCount: number, skippedSheets: string[], error?: string, reference?: string }} ThemeAudit  reference = the product whose themes this page was checked against */
/**
 * @typedef {object} ThemeReference  Another product's themes, read once per run (--theme-from).
 * @property {string} url
 * @property {{ id: string, tokens: { colors: { name: string, value: string }[], lengths: { name: string, px: number }[], fonts: { name: string, family: string }[] } }[]} themes
 */
/**
 * @typedef {object} Evidence
 * @property {string} finalUrl
 * @property {string} title
 * @property {string} [ariaSnapshotPath]
 * @property {string} pageTextExcerpt
 * @property {ScreenshotRef[]} screenshots
 * @property {ConsoleEntry[]} console
 * @property {NetworkFailure[]} networkFailures
 * @property {RequestRecord[]} [requests]  fetch/XHR/document requests the harness observed (static assets are only counted)
 * @property {RequestStats} [requestStats]
 * @property {DownloadRecord[]} [downloads]  files the browser downloaded during the test
 * @property {SeenText[]} [seenText]  transient messages (toasts, alerts, live regions) seen at any time
 * @property {VitalsRecord[]} [vitals]
 * @property {A11yResult} [a11y]
 * @property {ThemeAudit} [theme]  theme conformance of the final state, in every theme the build ships
 * @property {ThemeState[]} [themeStates]  every distinct screen the test reached that was audited, final included
 * @property {VisualEvidence} [visual]  screenshots for visual regression and how they compare with the baselines
 */
/**
 * @typedef {object} VisualCapture  A deterministic screenshot for comparison: no cursor, animations
 *   finished, data-aie2e-mask areas painted over.
 * @property {string} checkpoint  stable name: final, theme-dark, step-3-a1b2c3
 * @property {string} label  for people: "final", "final · dark", "after step 3"
 * @property {string} path  relative to the run dir
 * @property {string} url
 * @property {string} [theme]
 */
/**
 * @typedef {object} VisualResult
 * @property {string} checkpoint
 * @property {string} label
 * @property {string} [theme]
 * @property {'new' | 'unchanged' | 'changed' | 'size' | 'error'} status
 *   new = no approved baseline yet (saved when the test passes); size = the screenshot size changed
 * @property {string} current
 * @property {string} [baseline]  copy of the approved baseline, relative to the run dir
 * @property {string} [diff]  red = differing pixels
 * @property {number} [diffRatio]
 * @property {number} [diffPixels]
 * @property {{ x: number, y: number, width: number, height: number }} [box]
 * @property {string} [approvedAt]
 * @property {string} [approvedRun]
 * @property {boolean} [saved]  this screenshot became the baseline in this run
 * @property {string} [note]
 */
/** @typedef {{ captures: VisualCapture[], results?: VisualResult[] }} VisualEvidence */
/**
 * @typedef {object} Baseline  Harness snapshot of the start page BEFORE the agent acts.
 * @property {string} url
 * @property {string} text  Lower-cased visible text.
 * @property {string[]} visibleSelectors  `selector-visible` expectations already visible at the start.
 * @property {number} [requestCount]  Requests already seen at the start; `api-call` matches before this are vacuous.
 */
/**
 * @typedef {object} CheckResult
 * @property {Expectation} expectation
 * @property {boolean} passed
 * @property {string} detail
 * @property {boolean} [vacuous]  Already true on the start page, so it proves nothing about the agent's actions.
 * @property {boolean} [advisory]  Reported, but never changes the verdict (quality gate = "warn").
 */
/** @typedef {{ status: 'pass' | 'fail' | 'error', reason: string, checks: CheckResult[], warnings: string[] }} Verdict */

// ---------- Execution ----------
/** @typedef {'agent' | 'replay' | 'healed' | 'deterministic'} ExecutionMode */
/**
 * What the agent SAID happened. `status`, `observed` and `valuesUsed` come from its structured final report
 * (absent in older reports).
 * @typedef {{ success: boolean, message: string, status?: 'done' | 'blocked' | 'app-error', observed?: string[], valuesUsed?: string[] }} AgentClaim
 */
/**
 * @typedef {object} HealEvent
 * @property {string} testId
 * @property {number} stepIndex
 * @property {string} description
 * @property {string} [oldSelector]
 * @property {string} [newSelector]
 * @property {string} reason
 * @property {'healed' | 'failed'} outcome
 */
/**
 * @typedef {object} ExecutionOutcome
 * @property {ExecutionMode} mode
 * @property {AgentClaim} [agentClaim]  What the agent SAID happened. Recorded, never used for the verdict.
 * @property {RecordedStep[]} steps
 * @property {HealEvent[]} heals
 * @property {string} [error]  infrastructure problem (browser crashed...): verdict "error"
 * @property {string} [failure]  the app did not allow a step (replay without healing): verdict "fail"
 * @property {{ inputTokens: number, outputTokens: number }} [llmUsage]
 * @property {Baseline} [baseline]  Start-page snapshot used by the judge to spot vacuous expectations.
 * @property {boolean} [recordable]  True when `steps` fully capture what the agent did, so they can be replayed.
 * @property {TraceEntry[]} [trace]  Run log for the report.
 */

// ---------- Results ----------
/**
 * @typedef {object} TestResult
 * @property {TestCase} test
 * @property {ExecutionMode} mode
 * @property {Verdict} verdict
 * @property {Evidence} evidence
 * @property {AgentClaim} [agentClaim]
 * @property {boolean} claimMismatch  True when the agent's claim disagrees with the evidence-based verdict.
 * @property {HealEvent[]} heals
 * @property {number} durationMs
 * @property {{ inputTokens: number, outputTokens: number }} [llmUsage]  Browser-agent tokens for this test.
 * @property {TraceEntry[]} [trace]  What happened, step by step, with screenshots.
 */
/**
 * @typedef {object} RunSummary
 * @property {number} total
 * @property {number} passed
 * @property {number} failed
 * @property {number} errored
 * @property {number} healed  tests that passed only after a heal
 * @property {number} claimMismatches
 * @property {number} inputTokens  browser-agent tokens
 * @property {number} outputTokens
 * @property {{ inputTokens: number, outputTokens: number }} [overhead]  planner + judge (visual checks) tokens
 * @property {number} [visualChanges]  tests with at least one screenshot that differs from its baseline
 * @property {number} [visualNew]  screenshots that became a baseline in this run
 */
/**
 * @typedef {object} RunReport
 * @property {string} runId
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {string} targetUrl
 * @property {RunSummary} summary
 * @property {TestResult[]} results
 * @property {Consistency} [consistency]  how consistently the same kinds of element look across screens
 * @property {{ loginUrl: string, username: string, landedOn: string }} [auth]  the run logged in first (never the password)
 */
/**
 * @typedef {object} ConsistencyStyle
 * @property {Record<string, string>} style
 * @property {number} count
 * @property {string[]} pages  routes where this look appears
 * @property {{ selector: string, text: string }} example
 */
/**
 * @typedef {object} ConsistencyFinding  Advisory: never changes a verdict.
 * @property {'near-duplicate' | 'component-variants'} type
 *   near-duplicate = two looks of the same kind of element that differ only slightly (probably meant to be one);
 *   component-variants = an element the app names (data-aie2e-component) renders in more than one way
 * @property {string} theme
 * @property {string} kind
 * @property {string} [component]
 * @property {ConsistencyStyle[]} styles
 * @property {{ prop: string, a: string, b: string, deltaE?: number }[]} diffs
 * @property {string} message
 */
/**
 * @typedef {object} Consistency
 * @property {number} states  distinct screens audited in this run
 * @property {string[]} themes
 * @property {ConsistencyFinding[]} findings
 */

// ---------- Crawl / plan inputs ----------
/**
 * @typedef {object} SitePage
 * @property {string} url
 * @property {string} title
 * @property {string[]} links  Same-origin, safe-to-visit links found on the page
 * @property {string} [textExcerpt]
 * @property {number} [forms]
 * @property {string[]} [buttons]
 * @property {string[]} [apiCalls]  fetch/XHR calls the page made while loading, as "METHOD /path"
 * @property {string[]} [testIds]  stable selectors the app exposes, e.g. `[data-testid="export"] "Export"`
 * @property {string[]} [hints]  free-text `data-aie2e-hint` guidance the app gives testers
 */
/** @typedef {{ origin: string, pages: SitePage[] }} SiteMap */
/**
 * @typedef {object} Target
 * @property {string} url
 * @property {string} [description]
 * @property {string} [goal]
 * @property {string} [expectUrl]
 * @property {string[]} [expectText]
 */
