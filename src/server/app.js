import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';
import { llmRequirement } from '../app/startRun.js';
import { resolveChromePath } from '../browser/chrome.js';
import { loadConfig } from '../config/config.js';
import { RunManager } from './runManager.js';

/** Request body for POST /api/runs. Bounds keep a stray click from launching dozens of browsers. */
const StartBody = z.object({
  url: z.url({ protocol: /^https?$/ }),
  description: z.string().max(2000).optional(),
  goal: z.string().max(2000).optional(),
  expectUrl: z.string().max(500).optional(),
  expectText: z.array(z.string().max(500)).max(10).optional(),
  model: z.string().max(100).optional(),
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
  quality: z.enum(['off', 'warn', 'fail']).optional(),
});

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Local-only web server: REST + SSE for the UI, static reports/screenshots, the built UI itself.
 * It launches browsers on this machine, so it (a) should be bound to 127.0.0.1 by the caller and
 * (b) rejects any request whose Host header is not local (guards against DNS rebinding).
 *
 * @param {{ outDir: string, uiDir?: string, manager?: RunManager, logger?: boolean }} opts
 */
export async function createServer({ outDir, uiDir, manager, logger = false }) {
  const runs = manager ?? new RunManager({ outDir });
  const app = Fastify({ logger });
  const root = path.resolve(outDir);

  app.addHook('onRequest', async (req, reply) => {
    if (!LOCAL_HOSTS.test(req.headers.host ?? '')) {
      return reply.code(403).send({ error: 'Only local access is allowed' });
    }
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
      keyVar: need.keyVar ?? null,
      keyPresent: need.keyPresent,
      chrome,
      chromeOk: !!chrome && existsSync(chrome),
      outDir: root,
      active: runs.active?.runId ?? null,
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
    };
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
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
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
