import { describe, expect, it } from 'vitest';
import { actionsToSteps } from '../src/executor/steps.js';

/** @param {string} selector @param {string} [method] @param {string[]} [args] */
const act = (selector, method = 'click', args = []) => ({
  type: 'act',
  action: 'do it',
  playwrightArguments: { selector, method, arguments: args, description: 'Click it' },
});

describe('actionsToSteps', () => {
  it('turns act/goto/navback/wait into replayable steps, renumbered from startIndex', () => {
    const { steps, recordable } = actionsToSteps(
      [
        { type: 'goto', url: 'https://a.test/x' },
        act('xpath=/html/body/button'),
        act('xpath=/html/body/input', 'fill', ['hello']),
        { type: 'wait', timeMs: 500 },
        { type: 'navback' },
        { type: 'screenshot' },
        { type: 'ariaTree' },
        { type: 'done' },
      ],
      1,
    );
    expect(recordable).toBe(true);
    expect(steps.map((s) => [s.index, s.kind])).toEqual([
      [1, 'navigate'],
      [2, 'act'],
      [3, 'act'],
      [4, 'wait'],
      [5, 'back'],
    ]);
    expect(steps[2]).toMatchObject({ method: 'fill', arguments: ['hello'], selector: /input/ });
  });

  it('refuses to record when the agent used a tool we cannot replay', () => {
    expect(actionsToSteps([act('xpath=/a'), { type: 'dragAndDrop' }], 0).recordable).toBe(false);
  });

  it('refuses to record when nothing replayable happened', () => {
    expect(actionsToSteps([{ type: 'act', action: 'x' }, { type: 'done' }], 0).recordable).toBe(
      false,
    );
  });
});
