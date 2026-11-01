import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';
import { llmRequirement } from '../app/startRun.js';
import { resolveChromePath } from '../browser/chrome.js';
import { MODEL_PRESETS, agentModelWarning, loadConfig } from '../config/config.js';
import { RunManager } from './runManager.js';
import { BaselineStore } from '../visual/baselines.js';
import { SUITE_NAME, SuiteStore } from './suites.js';
import { FileRecordStore } from '../storage/recordStore.js';
import { suiteFromRun } from '../planner/suitePlanner.js';
import { testFingerprint } from '../storage/recordStore.js';
import { AuthSchema } from '../auth/login.js';
import { slugify } from '../util/misc.js';
import { AccessGate, accessConfig, hostAllowed, targetAllowed } from './access.js';

/** Request body for POST /api/runs. Bounds keep a stray click from launching dozens of browsers. */
const StartBody = z.object({
  url: z.url({ protocol: /^https?$/ }),
  description: z.string().max(2000).optional(),
  goal: z.string().max(2000).optional(),
  expectUrl: z.string().max(500).optional(),
  expectText: z.array(z.string().max(500)).max(10).optional(),
  model: z.string().max(100).optional(),
  preset: z.enum(['economy', 'balanced', 'best']).optional(),
  agentEngine: z.enum(['stagehand', 'loop']).optional(),
  headed: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(4).optional(),
  maxTests: z.number().int().min(1).max(8).optional(),
  maxSteps: z.number().int().min(1).max(60).optional(),
  maxPages: z.number().int().min(1).max(20).optional(),
  plan: z.boolean().optional(),
  crawl: z.boolean().optional(),
  cache: z.boolean().optional(),
  rerecord: z.boolean().optional(),
  replan: z.boolean().optional(),
  rounds: z.number().int().min(1).max(3).optional(),
  quality: z.enum(['off', 'warn', 'fail']).optional(),
  visual: z.enum(['off', 'warn', 'fail']).optional(),
  heal: z.boolean().optional(),
  explain: z.boolean().optional(),
  /** check the theme against another product's themes */
  themeFrom: z.url({ protocol: /^https?$/ }).optional(),
  /** log in first; credentials come from the server's .env, never from the request */
  auth: AuthSchema.omit({ steps: true }).optional(),
  /** a suite saved in the UI (its name); replaces planning */
  suite: z.string().regex(SUITE_NAME).optional(),
});

/**
 * Local-only web server: REST + SSE for the UI, static reports/screenshots, the built UI itself.
 * It launches browsers on this machine, so it (a) should be bound to 127.0.0.1 by the caller and
 * (b) rejects any request whose Host header is not local (guards against DNS rebinding). Deployed for
 * others (README, "Deploying"), it also needs an access code and refuses targets on the owner's network
 * (`./access.js`).
 *
 * @param {{ outDir: string, uiDir?: string, manager?: RunManager, logger?: boolean,
 *   access?: import('./access.js').AccessConfig }} opts
 */
export async function createServer({
  outDir,
  uiDir,
  manager,
  logger = false,
  access = accessConfig(),
}) {
  const runs = manager ?? new RunManager({ outDir });
  const app = Fastify({ logger });
  const root = path.resolve(outDir);

  const gate = access.code ? new AccessGate(access.code) : null;
  app.addHook('onRequest', async (req, reply) => {
    // the platform's health check may use any host name; it learns nothing but "ok"
    if (req.url === '/healthz') return reply.send('ok');
    if (!hostAllowed(req.headers.host ?? '', access)) {
      return reply.code(403).send({ error: 'Only local access is allowed' });
    }
    // with an access code, everyone needs it (a proxy may present itself as localhost)
    const guarded = req.url.startsWith('/api/') || req.url.startsWith('/files/');
    if (
      gate &&
      guarded &&
      !req.url.startsWith('/api/access') &&
      !gate.hasAccess(req.headers.cookie)
    ) {
      return reply.code(401).send({ error: 'Enter the access code', locked: true });
    }
  });

  // ---- access code (shared instances) ---------------------------------------------------------
  app.get('/api/access', async (req) => ({
    required: !!gate,
    ok: gate ? gate.hasAccess(req.headers.cookie) : true,
  }));
  app.post('/api/access', async (req, reply) => {
    if (!gate) return { ok: true };
    const who = String(req.headers['cf-connecting-ip'] ?? req.ip);
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const res = gate.tryCode(/** @type {any} */ (req.body)?.code, who, secure);
    if (!res.ok)
      return reply.code(res.retryAfterS ? 429 : 401).send({
        error: res.retryAfterS
          ? `Too many wrong codes. Try again in ${Math.ceil(res.retryAfterS / 60)} min.`
          : 'That code is not right',
      });
    reply.header('set-cookie', res.cookie);
    return { ok: true };
  });

  // ---- health -------------------------------------------------------------------------------
  app.get('/api/health', async () => {
    const config = loadConfig({ outDir: root });
    const need = llmRequirement({ url: 'http://x', model: config.model });
    const chrome = resolveChromePath(config) ?? null;
    return {
      model: config.model,
      plannerModel: config.plannerModel ?? config.model,
      judgeModel: config.judgeModel ?? config.model,
      preset: config.preset ?? null,
      presets: MODEL_PRESETS,
      agentWarning: agentModelWarning(config.model, config.agentEngine) ?? null,
      agentEngine: config.agentEngine,
      keyVar: need.keyVar ?? null,
      keyPresent: need.keyPresent,
      // local paths stay on this machine when the UI is shared
      chrome: access.shared ? undefined : chrome,
      chromeOk: !!chrome && existsSync(chrome),
      outDir: access.shared ? undefined : root,
      shared: access.shared
        ? { maxTests: access.maxTests, concurrency: access.concurrency, apps: access.apps }
        : null,
      active: runs.active?.runId ?? null,
      // the models the running run uses (a preset picked for it beats .env), for the sidebar
      activeModels: runs.active ? runModels(runs.active.options, config) : null,
      // whether a login can run (the values themselves never leave the server)
      loginCreds: !!process.env.AIE2E_USERNAME && !!process.env.AIE2E_PASSWORD,
    };
  });

  // ---- runs ---------------------------------------------------------------------------------
  app.post('/api/runs', async (req, reply) => {
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    if (access.shared) {
      // a shared instance: no targets on the owner's network, login only on listed origins, fewer tests
      const suite = parsed.data.suite
        ? await suites.get(parsed.data.suite).catch(() => null)
        : null;
      for (const u of [parsed.data.url, parsed.data.themeFrom, suite?.themeFrom].filter(Boolean)) {
        const t = await targetAllowed(/** @type {string} */ (u), access);
        if (!t.ok) return reply.code(403).send({ error: t.reason });
      }
      // the owner's password is typed only into a login page of an app the owner listed
      const auth = parsed.data.auth ?? suite?.auth;
      if (auth) {
        const app = new URL(parsed.data.url).origin;
        const login = new URL(auth.loginUrl, parsed.data.url).origin;
        if (login !== app || !access.allowedTargets.includes(app))
          return reply.code(403).send({
            error:
              'On a shared instance, logging in with the owner’s account only works on the apps the owner listed.',
          });
      }
      parsed.data.maxTests = Math.min(parsed.data.maxTests ?? access.maxTests, access.maxTests);
      parsed.data.headed = false;
      parsed.data.rounds = 1; // exploring deeper multiplies AI calls: not on the shared instance
      parsed.data.concurrency = Math.min(
        parsed.data.concurrency ?? access.concurrency,
        access.concurrency,
      );
    }
    const need = llmRequirement(parsed.data);
    if (need.needed && !need.keyPresent) {
      return reply.code(400).send({
        error: `${need.keyVar} is not set. Add it to .env (model: ${need.model}), or choose "Smoke check" which needs no AI.`,
      });
    }
    if (runs.active)
      return reply
        .code(409)
        .send({ error: 'A run is already in progress', runId: runs.active.runId });
    if (parsed.data.suite) {
      const file = suites.file(parsed.data.suite);
      if (!existsSync(file)) return reply.code(404).send({ error: 'No such suite' });
      const record = runs.start({ ...parsed.data, suite: file, suiteName: parsed.data.suite });
      return reply.code(202).send({ runId: record.runId });
    }
    const record = runs.start(parsed.data);
    return reply.code(202).send({ runId: record.runId });
  });

  app.get('/api/runs', async () => runs.list());

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = /** @type {{ id: string }} */ (req.params);
    const live = runs.get(id);
    const report = live?.report ?? (await runs.readReport(id));
    if (!live && !report) return reply.code(404).send({ error: 'Run not found' });
    return {
      runId: id,
      status: live?.status ?? 'done',
      startedAt: live?.startedAt ?? report?.startedAt,
      error: live?.error,
      options: live?.options ?? (await runs.readOptions(id)),
      report,
      review: await readReview(id),
    };
  });

  // ---- test suites authored in the UI (same JSON as --suite / aie2e export) -----------------------
  const suites = new SuiteStore(process.env.AIE2E_SUITES_DIR || path.join(root, 'suites'));
  /** @param {any} req */
  const suiteName = (req) => /** @type {{ name: string }} */ (req.params).name;
  app.get('/api/suites', async () => suites.list());
  app.get('/api/suites/:name', async (req, reply) => {
    const name = suiteName(req);
    if (!SUITE_NAME.test(name)) return reply.code(400).send({ error: 'Bad suite name' });
    try {
      return { name, suite: await suites.get(name) };
    } catch {
      return reply.code(404).send({ error: 'No such suite' });
    }
  });
  app.put('/api/suites/:name', async (req, reply) => {
    const name = suiteName(req);
    if (!SUITE_NAME.test(name))
      return reply
        .code(400)
        .send({ error: 'Use lowercase letters, digits and dashes for the name' });
    const before = await suites.get(name).catch(() => null);
    const res = await suites.save(name, req.body);
    if (!res.ok) return reply.code(400).send({ error: res.issues.join('; '), issues: res.issues });
    // Saved recordings win over a suite's own steps (they carry heals), so steps edited here would
    // never replay: drop the saved recording of every test whose steps changed.
    const cleared = [];
    for (const id of changedSteps(before, res.suite)) {
      const file = recFile(id);
      if (file && existsSync(file)) {
        await rm(file);
        cleared.push(id);
      }
    }
    return { name, suite: res.suite, cleared };
  });
  app.delete('/api/suites/:name', async (req, reply) => {
    const name = suiteName(req);
    if (!SUITE_NAME.test(name)) return reply.code(400).send({ error: 'Bad suite name' });
    await suites.remove(name);
    return { deleted: true };
  });
  // a run's tests plus their recorded steps, ready to edit and replay
  app.post('/api/suites/from-run/:id', async (req, reply) => {
    const { id } = /** @type {{ id: string }} */ (req.params);
    if (!/^[\w-]+$/.test(id)) return reply.code(400).send({ error: 'Bad run id' });
    const report = runs.get(id)?.report ?? (await runs.readReport(id));
    if (!report) return reply.code(404).send({ error: 'Run not found' });
    const store = new FileRecordStore(path.join(root, 'recordings'));
    const suite = { ...(await suiteFromRun(report, (t) => store.load(t))), url: report.targetUrl };
    const host = new URL(report.targetUrl).host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const name = `${host}-${id.slice(-4)}`.replace(/^-+/, '').slice(0, 60);
    const res = await suites.save(name, suite);
    if (!res.ok) return reply.code(400).send({ error: res.issues.join('; ') });
    return { name, suite: res.suite };
  });

  // ---- visual review: approve a screenshot as the new baseline, or reject the change -------------
  /** @param {string} id */
  const reviewFile = (id) => path.join(root, 'runs', id, 'visual-review.json');
  /** @param {string} id @returns {Promise<Record<string, { action: string, at: string }>>} */
  const readReview = async (id) => {
    try {
      return JSON.parse(await readFile(reviewFile(id), 'utf8'));
    } catch {
      return {};
    }
  };
  const ReviewBody = z.object({
    testId: z.string().min(1),
    checkpoint: z.string().min(1),
    action: z.enum(['approve', 'reject']),
  });
  app.post('/api/runs/:id/visual', async (req, reply) => {
    const { id } = /** @type {{ id: string }} */ (req.params);
    if (!/^[\w-]+$/.test(id)) return reply.code(400).send({ error: 'Bad run id' });
    const body = ReviewBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'testId, checkpoint and action are required' });
    const { testId, checkpoint, action } = body.data;
    const report = runs.get(id)?.report ?? (await runs.readReport(id));
    const result = report?.results.find((r) => r.test.id === testId);
    const shot = result?.evidence.visual?.results?.find((v) => v.checkpoint === checkpoint);
    if (!report || !result || !shot)
      return reply.code(404).send({ error: 'No such screenshot in this run' });
    if (action === 'approve') {
      const cfg = loadConfig({ outDir: root });
      const store = new BaselineStore(
        cfg.visual.dir ?? path.join(root, 'baselines'),
        report.targetUrl,
      );
      await store.save(testId, checkpoint, path.join(root, 'runs', id, shot.current), {
        runId: id,
        fingerprint: testFingerprint(result.test),
        how: 'approved',
      });
    }
    const review = await readReview(id);
    review[`${testId}|${checkpoint}`] = { action, at: new Date().toISOString() };
    await writeFile(reviewFile(id), JSON.stringify(review, null, 2));
    return { review };
  });

  app.post('/api/runs/:id/stop', async (req, reply) => {
    const { id } = /** @type {{ id: string }} */ (req.params);
    return runs.stop(id)
      ? { stopped: true }
      : reply.code(404).send({ error: 'No such running run' });
  });

  // Server-Sent Events: replay everything so far, then stream live. GET, so the browser's native
  // EventSource works. No auto-retry games: when the run ends the client closes the stream.
  app.get('/api/runs/:id/events', (req, reply) => {
    const { id } = /** @type {{ id: string }} */ (req.params);
    const live = runs.get(id);
    if (!live) return reply.code(404).send({ error: 'Run is not live (open its report instead)' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (/** @type {import('../events/runEvents.js').RunEvent} */ e) =>
      res.write(
        `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.type === 'frame' ? e.data : { ...e.data, at: e.ts })}\n\n`,
      );
    const wantsFrames = req.query && /** @type {any} */ (req.query).frames !== '0';
    if (wantsFrames) live.events.adjustLiveViewers(1);
    const unsubscribe = live.events.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (wantsFrames) live.events.adjustLiveViewers(-1);
    });
  });

  // ---- recordings ---------------------------------------------------------------------------
  const recDir = path.join(root, 'recordings');
  /** @param {string} id */
  const recFile = (id) =>
    /^[a-z0-9][a-z0-9-]*$/.test(id) ? path.join(recDir, `${id}.json`) : null;

  app.get('/api/recordings', async () => {
    const files = existsSync(recDir)
      ? (await readdir(recDir)).filter((f) => f.endsWith('.json'))
      : [];
    const out = [];
    for (const f of files) {
      try {
        const r = JSON.parse(await readFile(path.join(recDir, f), 'utf8'));
        out.push({ testId: r.testId, recordedAt: r.recordedAt, steps: r.steps?.length ?? 0 });
      } catch {
        /* skip corrupt file */
      }
    }
    return out.sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
  });

  app.get('/api/recordings/:id', async (req, reply) => {
    const file = recFile(/** @type {{ id: string }} */ (req.params).id);
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'Not found' });
    return JSON.parse(await readFile(file, 'utf8'));
  });

  app.delete('/api/recordings/:id', async (req, reply) => {
    const file = recFile(/** @type {{ id: string }} */ (req.params).id);
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'Not found' });
    await rm(file);
    return { deleted: true };
  });

  // ---- static: run artifacts (reports, screenshots) and the built UI ------------------------
  await mkdir(path.join(root, 'runs'), { recursive: true });
  await app.register(fastifyStatic, {
    root: path.join(root, 'runs'),
    prefix: '/files/runs/',
    decorateReply: false,
  });
  if (uiDir && existsSync(uiDir)) {
    await app.register(fastifyStatic, { root: path.resolve(uiDir), prefix: '/' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.url.startsWith('/files/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
  }
  return { app, runs };
}

/**
 * Test ids whose hand-written steps differ between two versions of a suite.
 * @param {{ tests: { id?: string, title: string, steps?: unknown[] }[] } | null} before
 * @param {{ tests: { id?: string, title: string, steps?: unknown[] }[] }} after
 */
export function changedSteps(before, after) {
  const key = (/** @type {{ id?: string, title: string }} */ t) => t.id ?? slugify(t.title);
  const old = new Map((before?.tests ?? []).map((t) => [key(t), JSON.stringify(t.steps ?? [])]));
  return after.tests
    .filter((t) => old.has(key(t)) && old.get(key(t)) !== JSON.stringify(t.steps ?? []))
    .map(key);
}

/**
 * The models a run uses: the preset picked for it, else the ones from .env (D26).
 * @param {{ preset?: string, agentEngine?: string }} options
 * @param {{ model: string, plannerModel?: string, judgeModel?: string, agentEngine?: string }} config
 */
export function runModels(options, config) {
  const p = options.preset
    ? MODEL_PRESETS[/** @type {keyof typeof MODEL_PRESETS} */ (options.preset)]
    : undefined;
  return {
    preset: options.preset ?? null,
    model: p?.model ?? config.model,
    plannerModel: p?.plannerModel ?? config.plannerModel ?? config.model,
    judgeModel: p?.judgeModel ?? config.judgeModel ?? config.model,
    agentEngine: options.agentEngine ?? config.agentEngine,
  };
}
