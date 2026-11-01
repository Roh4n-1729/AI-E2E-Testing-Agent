import readline from 'node:readline';

/**
 * Human in the loop from the terminal: when the agent asks for help, print what it needs and wait for Enter (done)
 * or "skip" (cannot). The UI's buttons do the same for runs started there.
 * @param {import('../events/runEvents.js').RunEvents} events
 * @param {import('../core/humanHelp.js').HumanHelp} help
 * @returns {() => void} stop listening
 */
export function askInTerminal(events, help) {
  /** @type {readline.Interface | undefined} */
  let rl;
  const unsubscribe = events.subscribe(
    (e) => {
      if (e.type === 'test.helped' && e.data.answer !== 'done' && e.data.answer !== 'skipped') {
        rl?.close(); // timed out or stopped: the question is gone
        rl = undefined;
        return;
      }
      if (e.type !== 'test.waiting') return;
      const { testId, what, waitMs } = e.data;
      rl?.close();
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const minutes = Math.round(Number(waitMs) / 60_000);
      rl.question(
        `\n⏸  The agent needs you (${testId}): ${what}\n   Do it in the browser window, then press Enter. Type "skip" if you cannot (waits ${minutes} min). `,
        (line) => {
          rl?.close();
          rl = undefined;
          const skip = /^\s*(skip|s|no|n)\s*$/i.test(line);
          help.answer(testId, skip ? 'skipped' : 'done', skip ? undefined : line);
        },
      );
    },
    { replay: false },
  );
  return () => {
    unsubscribe();
    rl?.close();
  };
}
