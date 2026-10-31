import { describe, expect, it } from 'vitest';
import { testInputs } from '../src/core/testRunner.js';
import { testFingerprint } from '../src/storage/recordStore.js';

/** @typedef {import('../src/core/types.js').ExecutionOutcome} Outcome */
const steps = [
  { index: 0, kind: /** @type {const} */ ('navigate'), description: 'Open /', url: '/' },
];
const agentInput = {
  model: 'anthropic/claude-haiku-4-5',
  engine: /** @type {const} */ ('stagehand'),
  instruction: 'Goal: buy',
};

describe('who did what: the inputs each part of the tool got', () => {
  it('names who wrote the steps Playwright ran', () => {
    /** @param {Partial<Outcome>} o */
    const src = (o) => testInputs({ mode: 'replay', steps, heals: [], ...o }).playwright;
    expect(src({ recordedAt: 'suite' })).toMatchObject({ source: 'suite' });
    expect(src({ recordedAt: '2026-10-30T10:00:00Z' })).toMatchObject({
      source: 'recording',
      recordedAt: '2026-10-30T10:00:00Z',
    });
    expect(src({ mode: 'agent', agentInput })).toMatchObject({ source: 'agent' });
    expect(src({ mode: 'deterministic' })).toMatchObject({ source: 'harness' });
  });

  it('keeps what the agent was told, only when it ran', () => {
    expect(testInputs({ mode: 'agent', steps, heals: [], agentInput }).agent).toEqual(agentInput);
    expect(testInputs({ mode: 'replay', steps, heals: [] }).agent).toBeUndefined();
  });

  it('rewording a check label keeps the recording', () => {
    const test = {
      id: 't',
      title: 't',
      goal: 'g',
      startUrl: 'https://a.test/',
      tags: [],
      expectations: [{ kind: /** @type {const} */ ('text-visible'), text: 'Done' }],
    };
    const labelled = {
      ...test,
      expectations: [
        { kind: /** @type {const} */ ('text-visible'), text: 'Done', label: 'The order is done' },
      ],
    };
    expect(testFingerprint(labelled)).toBe(testFingerprint(test));
    expect(testFingerprint({ ...test, origin: 'suite' })).toBe(testFingerprint(test));
  });
});

describe('suite steps edited in the UI', () => {
  it('names the tests whose steps changed, so their old recordings are dropped', async () => {
    const { changedSteps } = await import('../src/server/app.js');
    const step = (/** @type {string} */ sel) => ({
      kind: 'act',
      description: 'Click',
      selector: sel,
      method: 'click',
    });
    const before = {
      tests: [
        { title: 'Add to cart', steps: [step('#a')] },
        { id: 'pay', title: 'Pay', steps: [step('#p')] },
        { title: 'Browse' },
      ],
    };
    const after = {
      tests: [
        { title: 'Add to cart', steps: [step('#a')] },
        { id: 'pay', title: 'Pay', steps: [step('#pay-now')] },
        { title: 'Browse', steps: [step('#b')] },
        { title: 'New one', steps: [step('#n')] },
      ],
    };
    expect(changedSteps(before, after)).toEqual(['pay', 'browse']);
    expect(changedSteps(null, after)).toEqual([]);
  });
});
