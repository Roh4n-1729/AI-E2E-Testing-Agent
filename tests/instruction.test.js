import { describe, expect, it } from 'vitest';
import { buildInstruction } from '../src/executor/agentExecutor.js';

/** @type {import('../src/core/types.js').TestCase} */
const test = {
  id: 't',
  title: 'Improve a slide',
  goal: 'Rewrite the second slide with AI',
  startUrl: 'https://app.test/',
  expectations: [],
  tags: [],
};

describe('the agent instruction (both engines)', () => {
  it('tells the agent to look past buttons before it gives up', () => {
    const text = buildInstruction(test);
    expect(text).toContain('Goal: Rewrite the second slide with AI');
    // features reached by asking in words, as AI apps do
    expect(text).toContain('text box or chat panel');
    expect(text).toContain('type a clear request');
    // "blocked" only after trying another way, and saying which
    expect(text).toContain('Before you report that the goal cannot be done');
  });

  it('says where a test that starts deeper begins, and that a healed one continues', () => {
    const steps = [
      { index: 0, kind: /** @type {const} */ ('navigate'), description: 'Open the app' },
      { index: 1, kind: /** @type {const} */ ('act'), description: 'Generate a deck' },
    ];
    const baseline = { url: '', text: '', visibleSelectors: [] };
    expect(buildInstruction(test, { completed: steps, baseline })).toContain(
      'These steps were already done for you',
    );
    expect(
      buildInstruction(test, { completed: steps.slice(0, 1), failed: steps[1], baseline }),
    ).toContain('The step that failed was: "Generate a deck"');
  });
});

describe('ids a framework made up are never used as recorded selectors', () => {
  it('recognises React, Radix and similar generated ids, and keeps real ones', async () => {
    const { GENERATED_ID } = await import('../src/browser/hints.js');
    for (const id of [
      'radix-_r_e_',
      ':r1:',
      '«r3»',
      'headlessui-menu-button-7',
      'mui-12',
      'ember456',
    ])
      expect(GENERATED_ID.test(id), id).toBe(true);
    for (const id of ['checkout', 'add-to-cart', 'main-menu', 'gen'])
      expect(GENERATED_ID.test(id), id).toBe(false);
  });
});
