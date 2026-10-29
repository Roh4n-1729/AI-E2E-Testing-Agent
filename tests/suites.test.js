import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server/app.js';

const out = mkdtempSync(path.join(os.tmpdir(), 'aie2e-suites-'));
const { app } = await createServer({ outDir: out, uiDir: path.join(out, 'no-ui') });
afterAll(() => app.close());

/** @param {string} method @param {string} url @param {unknown} [payload] */
const call = (method, url, payload) =>
  app.inject({ method: /** @type {any} */ (method), url, payload: /** @type {any} */ (payload) });

describe('test suites API', () => {
  it('saves, lists, reads and deletes a suite', async () => {
    const suite = {
      url: 'http://localhost:4310/',
      tests: [
        {
          title: 'Checkout refuses an empty email',
          goal: 'Open checkout, leave the email empty and place the order',
          startUrl: '/checkout',
          expectations: [{ kind: 'text-visible', text: 'Enter your email' }],
        },
      ],
    };
    expect((await call('PUT', '/api/suites/checkout', suite)).statusCode).toBe(200);
    const list = (await call('GET', '/api/suites')).json();
    expect(list).toMatchObject([{ name: 'checkout', tests: 1, recorded: 0 }]);
    const got = (await call('GET', '/api/suites/checkout')).json();
    expect(got.suite.tests[0].expectations[0]).toEqual({
      kind: 'text-visible',
      text: 'Enter your email',
    });
    expect((await call('DELETE', '/api/suites/checkout')).json()).toEqual({ deleted: true });
    expect((await call('GET', '/api/suites/checkout')).statusCode).toBe(404);
  });

  it('explains what is wrong instead of saving an invalid suite, and refuses unsafe names', async () => {
    const bad = await call('PUT', '/api/suites/broken', {
      tests: [{ title: '', expectations: [{ kind: 'text-visible' }] }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.join(' ')).toMatch(/tests\.0\.title/);
    expect(
      (await call('PUT', '/api/suites/..%2Fescape', { tests: [{ title: 'x' }] })).statusCode,
    ).toBe(400);
    expect((await call('PUT', '/api/suites/Upper', { tests: [{ title: 'x' }] })).statusCode).toBe(
      400,
    );
  });

  it('turns a finished run into a suite, keeping recorded steps', async () => {
    const runId = '20261030020202-abcd';
    mkdirSync(path.join(out, 'runs', runId), { recursive: true });
    mkdirSync(path.join(out, 'recordings'), { recursive: true });
    const test = {
      id: 'add-mug',
      title: 'Add the mug',
      goal: 'Add the mug to the cart',
      startUrl: 'http://localhost:4310/',
      expectations: [{ kind: 'text-visible', text: 'Cart (1)' }, { kind: 'no-console-errors' }],
      tags: [],
    };
    writeFileSync(
      path.join(out, 'runs', runId, 'report.json'),
      JSON.stringify({
        runId,
        targetUrl: 'http://localhost:4310/',
        results: [{ test }],
      }),
    );
    const { testFingerprint } = await import('../src/storage/recordStore.js');
    writeFileSync(
      path.join(out, 'recordings', 'add-mug.json'),
      JSON.stringify({
        schemaVersion: 1,
        testId: 'add-mug',
        fingerprint: testFingerprint(/** @type {any} */ (test)),
        recordedAt: '',
        steps: [
          { index: 0, kind: 'navigate', description: 'Open', url: 'http://localhost:4310/' },
          {
            index: 1,
            kind: 'act',
            description: 'Add the mug',
            selector: '#add-mug',
            method: 'click',
          },
        ],
      }),
    );
    const res = await call('POST', `/api/suites/from-run/${runId}`);
    expect(res.statusCode).toBe(200);
    const { name, suite } = res.json();
    expect(name).toBe('localhost-4310-abcd');
    expect(suite.url).toBe('http://localhost:4310/');
    expect(suite.tests[0]).toMatchObject({
      startUrl: '/',
      expectations: [{ kind: 'text-visible', text: 'Cart (1)' }], // guards are added at run time
      steps: [{ kind: 'act', description: 'Add the mug', selector: '#add-mug', method: 'click' }],
    });
  });
});
