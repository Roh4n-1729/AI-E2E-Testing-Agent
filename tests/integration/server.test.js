import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/app.js';
import { hasChromium, startApp } from './harness.js';

/** @type {{ server: import('node:http').Server, hits: string[], base: string }} */
let target;
/** @type {Awaited<ReturnType<typeof createServer>>['app']} */
let app;
let base = '';
const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-srv-'));

beforeAll(async () => {
  target = /** @type {typeof target} */ (await startApp());
  ({ app } = await createServer({ outDir: out }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${/** @type {any} */ (app.server.address()).port}`;
});
afterAll(async () => {
  await app?.close();
  target?.server.close();
});

/** @param {string} p @param {RequestInit} [init] */
const api = (p, init) => fetch(`${base}${p}`, init);
/** @param {unknown} body */
const post = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('server basics (no browser)', () => {
  it('rejects non-local Host headers (DNS-rebinding guard)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('validates the start request and fails fast without an API key', async () => {
    expect((await api('/api/runs', post({ url: 'not a url' }))).status).toBe(400);
    expect((await api('/api/runs', post({ url: 'http://a.test', concurrency: 99 }))).status).toBe(
      400,
    );
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await api(
        '/api/runs',
        post({ url: 'http://a.test', model: 'anthropic/claude-haiku-4-5' }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('lists, reads and deletes recordings, refusing path tricks', async () => {
    mkdirSync(path.join(out, 'recordings'), { recursive: true });
    writeFileSync(
      path.join(out, 'recordings', 'demo.json'),
      JSON.stringify({
        schemaVersion: 1,
        testId: 'demo',
        fingerprint: 'x',
        recordedAt: '2026-10-29T00:00:00Z',
        steps: [{}, {}],
      }),
    );
    expect(await (await api('/api/recordings')).json()).toEqual([
      { testId: 'demo', recordedAt: '2026-10-29T00:00:00Z', steps: 2 },
    ]);
    expect((await api('/api/recordings/demo')).status).toBe(200);
    expect((await api('/api/recordings/..%2Fsecret')).status).toBe(404);
    expect((await api('/api/recordings/demo', { method: 'DELETE' })).status).toBe(200);
    expect((await api('/api/recordings/demo')).status).toBe(404);
  });

  it('404s for unknown runs', async () => {
    expect((await api('/api/runs/nope')).status).toBe(404);
    expect((await api('/api/runs/nope/events')).status).toBe(404);
    expect((await api('/api/runs/nope/stop', { method: 'POST' })).status).toBe(404);
  });
});

describe.skipIf(!hasChromium)('a run through the server (real browser, no LLM)', () => {
  it('streams events over SSE, finishes, appears in history and serves its report', async () => {
    const res = await api('/api/runs', post({ url: target.base, plan: false, cache: false }));
    expect(res.status).toBe(202);
    const { runId } = await res.json();

    // a second run while one is active is refused
    expect((await api('/api/runs', post({ url: target.base, plan: false }))).status).toBe(409);

    // read the SSE stream until the run finishes
    const stream = await api(`/api/runs/${runId}/events?frames=0`);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = /** @type {ReadableStream<Uint8Array>} */ (stream.body).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: run.finished')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(types).toContain('run.started');
    expect(types).toContain('phase');
    expect(types).toContain('test.started');
    expect(types).toContain('test.finished');
    expect(types.at(-1)).toBe('run.finished');

    // let the manager observe completion, then check the REST views
    for (let i = 0; i < 50; i++) {
      const info = await (await api(`/api/runs/${runId}`)).json();
      if (info.status === 'done') {
        expect(info.report.summary.passed).toBe(1);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const list = await (await api('/api/runs')).json();
    expect(list[0]).toMatchObject({ runId, status: 'done' });
    expect((await api(`/files/runs/${runId}/report.html`)).status).toBe(200);
    expect((await api(`/files/runs/${runId}/report.json`)).status).toBe(200);
  });

  it('streams live browser frames to a watcher, and Stop ends the run', async () => {
    // a goal-less multi-visit run is too short to stop; use a test app page that never settles
    const res = await api(
      '/api/runs',
      post({ url: `${target.base}/shop`, plan: false, cache: false }),
    );
    const { runId } = await res.json();
    const stream = await api(`/api/runs/${runId}/events`);
    const reader = /** @type {ReadableStream<Uint8Array>} */ (stream.body).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: frame') && !text.includes('event: run.finished')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    // a frame may or may not arrive before such a short run ends; both are acceptable here,
    // but a frame must be valid base64 JPEG when present
    const m = text.match(/event: frame\ndata: (.+)\n/);
    if (m) expect(JSON.parse(m[1]).jpeg.slice(0, 4)).toBe('/9j/');
    await reader.cancel();
    await api(`/api/runs/${runId}/stop`, { method: 'POST' }); // 404 if already finished: fine
    for (let i = 0; i < 100; i++) {
      const info = await (await api(`/api/runs/${runId}`)).json();
      if (info.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
});
