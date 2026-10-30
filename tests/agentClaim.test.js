import { describe, expect, it } from 'vitest';
import { toClaim } from '../src/executor/agentExecutor.js';
import { actionsToSteps } from '../src/executor/steps.js';

describe("the agent's structured final report", () => {
  it('keeps status, observations and the test data it made up; success needs status "done"', () => {
    expect(
      toClaim({
        success: true,
        message: 'prose',
        output: {
          status: 'app-error',
          summary: 'Clicked Explore Now; the community page shows a server error.',
          observed: ['Application error: a server-side exception has occurred'],
        },
      }),
    ).toEqual({
      success: false,
      message: 'Clicked Explore Now; the community page shows a server error.',
      status: 'app-error',
      observed: ['Application error: a server-side exception has occurred'],
    });
    const done = toClaim({
      success: true,
      message: 'x',
      output: {
        status: 'done',
        summary: 'Ordered.',
        observed: [],
        valuesUsed: ['email: test@example.com'],
      },
    });
    expect(done).toMatchObject({ success: true, valuesUsed: ['email: test@example.com'] });
  });

  it('falls back to success + message when there is no structured report', () => {
    expect(toClaim({ success: true, message: 'done' })).toEqual({ success: true, message: 'done' });
    expect(toClaim({ success: false, message: 'm', output: { status: 'weird' } })).toEqual({
      success: false,
      message: 'm',
    });
  });

  it('harnessStatus calls never break a recording', () => {
    const { steps, recordable } = actionsToSteps(
      [
        { type: 'act', playwrightArguments: { selector: 'xpath=/a', method: 'click' } },
        { type: 'harnessStatus', why: 'nothing happened' },
      ],
      0,
    );
    expect(steps).toHaveLength(1);
    expect(recordable).toBe(true);
  });
});
