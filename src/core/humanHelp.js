import { nullEvents } from '../events/runEvents.js';

/**
 * Human in the loop. Some steps only a person can do: a CAPTCHA, a one-time code, a verification email, a real
 * payment, a file the harness has no sample for. The agent asks for help with a tool; this broker pauses that
 * test until someone answers (the UI's "Done" / "I can't" buttons, or Enter in the terminal), or until the wait
 * runs out.
 *
 * Help is only possible where someone can act in the test's browser: when the browser is shown on the machine
 * that runs the tests. Everywhere else (headless, CI, the deployed instance) the answer is "nobody can help" at
 * once, and the test is reported as needing a person instead of as an app failure.
 *
 * What a person did is never trusted silently: the result lists every request and its answer, a test a person
 * helped is labelled as helped, and its run is never recorded, because a replay cannot repeat what they did.
 *
 * @import { RunEvents } from '../events/runEvents.js'
 */

/**
 * @typedef {'done' | 'skipped' | 'timeout' | 'unavailable' | 'stopped'} HelpAnswer
 *   done: the person says they did it. skipped: they said they cannot. timeout: nobody answered in time.
 *   unavailable: nobody can act in this run's browser. stopped: the run was stopped while waiting.
 * @typedef {object} HelpRequest
 * @property {string} what  what the agent asked a person to do
 * @property {HelpAnswer} answer
 * @property {string} [note]  what the person typed, if anything
 * @property {string} ts  when it was asked
 * @property {number} waitedMs
 */

export class HumanHelp {
  /** @type {Map<string, { what: string, since: number, settle: (a: { answer: HelpAnswer, note?: string }) => void }>} */
  #pending = new Map();

  /**
   * @param {{ available: boolean, waitMs?: number, events?: RunEvents }} opts
   *   available: someone can act in the test's browser (it is shown on this machine)
   */
  constructor({ available, waitMs = 300_000, events = nullEvents }) {
    this.available = available;
    this.waitMs = waitMs;
    this.events = events;
  }

  /** Tests waiting for a person right now. */
  get waiting() {
    return [...this.#pending].map(([testId, p]) => ({ testId, what: p.what, since: p.since }));
  }

  /**
   * Pause a test until a person answers. Resolves, never rejects.
   * @param {string} testId @param {string} what @param {AbortSignal} [signal]
   * @returns {Promise<HelpRequest>}
   */
  async ask(testId, what, signal) {
    const ts = new Date().toISOString();
    const since = Date.now();
    /** @param {HelpAnswer} answer @param {string} [note] @returns {HelpRequest} */
    const request = (answer, note) => ({
      what,
      answer,
      ...(note ? { note } : {}),
      ts,
      waitedMs: Date.now() - since,
    });
    if (!this.available) return request('unavailable');
    if (signal?.aborted) return request('stopped');
    this.#pending.get(testId)?.settle({ answer: 'skipped' }); // one question per test at a time
    /** @type {{ answer: HelpAnswer, note?: string }} */
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => settle({ answer: 'timeout' }), this.waitMs);
      const onAbort = () => settle({ answer: 'stopped' });
      signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (/** @type {{ answer: HelpAnswer, note?: string }} */ a) => {
        if (this.#pending.get(testId)?.settle !== settle) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#pending.delete(testId);
        resolve(a);
      };
      this.#pending.set(testId, { what, since, settle });
      this.events.emit('test.waiting', { testId, what, waitMs: this.waitMs });
    });
    this.events.emit('test.helped', { testId, answer: got.answer });
    return request(got.answer, got.note);
  }

  /**
   * A person's answer, from the UI or the terminal. Returns false when that test is not waiting.
   * @param {string} testId @param {'done' | 'skipped'} answer @param {string} [note]
   */
  answer(testId, answer, note) {
    const p = this.#pending.get(testId);
    if (!p) return false;
    p.settle({ answer, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) });
    return true;
  }
}

/** What the agent is told after it asked. @param {HelpRequest} r */
export function helpReply(r) {
  switch (r.answer) {
    case 'done':
      return {
        helped: true,
        message: `The person says it is done${r.note ? ` ("${r.note}")` : ''}. Look at the page again and continue with the goal.`,
      };
    case 'unavailable':
      return {
        helped: false,
        message:
          'Nobody can help in this run: no person can act in this browser. Stop now and finish with status "needs-person", saying in one sentence what a person would have to do.',
      };
    case 'stopped':
      return { helped: false, message: 'The run was stopped. Finish now.' };
    default:
      return {
        helped: false,
        message: `The person ${r.answer === 'timeout' ? 'did not answer in time' : 'said they cannot do it'}. Stop now and finish with status "needs-person", saying what a person would have to do.`,
      };
  }
}

/** Did a person do something in this test? @param {HelpRequest[] | undefined} help */
export const wasHelped = (help) => !!help?.some((h) => h.answer === 'done');

/** Did the test need a person nobody provided? @param {HelpRequest[] | undefined} help */
export const neededPerson = (help) => !!help?.some((h) => h.answer !== 'done');

/** The tool description both agent engines use. */
export const ASK_FOR_HELP =
  'Ask the person running this test to do something only a human can do, then wait for them: solve a CAPTCHA, ' +
  'enter a one-time or two-factor code, open a verification email, approve a real payment, or choose a file the ' +
  'harness could not supply (harnessStatus shows file pickers it answered). Say exactly what to do, in one ' +
  'sentence. Never use it for something you can do yourself, to skip a hard step, or to ask a question.';
