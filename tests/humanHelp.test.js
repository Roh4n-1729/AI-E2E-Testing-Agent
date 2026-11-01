import { describe, expect, it } from 'vitest';
import { HumanHelp, helpReply, neededPerson, wasHelped } from '../src/core/humanHelp.js';
import { RunEvents } from '../src/events/runEvents.js';

describe('human in the loop', () => {
  it('answers at once when nobody can act in the browser', async () => {
    const events = new RunEvents();
    const help = new HumanHelp({ available: false, events });
    const r = await help.ask('t1', 'Enter the 2FA code');
    expect(r).toMatchObject({ what: 'Enter the 2FA code', answer: 'unavailable' });
    expect(events.history.filter((e) => e.type === 'test.waiting')).toHaveLength(0);
    expect(helpReply(r)).toMatchObject({ helped: false });
    expect(helpReply(r).message).toContain('needs-person');
  });

  it('pauses the test until the person answers, and tells the UI both ways', async () => {
    const events = new RunEvents();
    const help = new HumanHelp({ available: true, events });
    const asked = help.ask('t1', 'Solve the CAPTCHA');
    expect(help.waiting).toEqual([
      expect.objectContaining({ testId: 't1', what: 'Solve the CAPTCHA' }),
    ]);
    expect(help.answer('other', 'done')).toBe(false);
    expect(help.answer('t1', 'done', 'ticked the boxes')).toBe(true);
    const r = await asked;
    expect(r).toMatchObject({ answer: 'done', note: 'ticked the boxes' });
    expect(help.waiting).toEqual([]);
    expect(events.history.map((e) => e.type)).toEqual(['test.waiting', 'test.helped']);
    expect(helpReply(r)).toMatchObject({ helped: true });
    expect(wasHelped([r])).toBe(true);
    expect(neededPerson([r])).toBe(false);
  });

  it('gives up after the wait, and when the run is stopped', async () => {
    const help = new HumanHelp({ available: true, waitMs: 30 });
    const late = await help.ask('t1', 'Open the verification email');
    expect(late.answer).toBe('timeout');
    expect(neededPerson([late])).toBe(true);

    const stop = new AbortController();
    const slow = new HumanHelp({ available: true, waitMs: 60_000 });
    const asked = slow.ask('t2', 'Approve the payment', stop.signal);
    stop.abort();
    expect((await asked).answer).toBe('stopped');
    expect(slow.waiting).toEqual([]);
  });

  it('a person who says they cannot is "needs a person", not "helped"', async () => {
    const help = new HumanHelp({ available: true });
    const asked = help.ask('t1', 'Pick a video file');
    help.answer('t1', 'skipped');
    const r = await asked;
    expect(r.answer).toBe('skipped');
    expect(wasHelped([r])).toBe(false);
    expect(neededPerson([r])).toBe(true);
    expect(helpReply(r).message).toContain('said they cannot');
  });
});
