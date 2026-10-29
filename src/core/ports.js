/**
 * Ports: the contracts between the orchestrator and its adapters. Interfaces only (JSDoc
 * typedefs), so this file has no runtime code.
 *
 * @import { BrowserSession } from '../browser/session.js'
 * @import { TestArtifacts } from '../storage/artifacts.js'
 * @import { RunEvents } from '../events/runEvents.js'
 * @import { Logger } from '../util/logger.js'
 * @import { Evidence, ExecutionOutcome, Recording, RunReport, SiteMap, Target, TestCase, Verdict } from './types.js'
 */

/**
 * Everything an executor/judge needs besides the browser.
 * @typedef {{ runId: string, testId: string, artifacts: TestArtifacts, logger: Logger, events: RunEvents }} TestContext
 */

/** @typedef {{ crawl(target: Target): Promise<SiteMap> }} Crawler */

/** @typedef {{ plan(target: Target, siteMap: SiteMap): Promise<TestCase[]> }} Planner */

/** @typedef {{ execute(test: TestCase, session: BrowserSession, ctx: TestContext): Promise<ExecutionOutcome> }} Executor */

/**
 * The judge NEVER reads the agent's own claim to decide pass/fail. It collects evidence
 * itself (via the session) and checks the test's expectations against it.
 * @typedef {{ judge(test: TestCase, session: BrowserSession, outcome: ExecutionOutcome, ctx: TestContext): Promise<{ verdict: Verdict, evidence: Evidence }> }} Judge
 */

/** @typedef {{ report(report: RunReport): Promise<void> }} Reporter */

/** Saturday: persistence for recorded deterministic tests.
 * @typedef {{ load(testId: string): Promise<Recording | null>, save(recording: Recording): Promise<void> }} RecordStore
 */

/**
 * Structured LLM access. Implementations: AiSdkLlm (real), or a mock model in tests.
 * @typedef {{ generateObject<T>(args: { schema: import('zod').ZodType<T>, system: string, prompt: string, images?: Uint8Array[] }): Promise<T> }} LlmClient
 */

export {};
