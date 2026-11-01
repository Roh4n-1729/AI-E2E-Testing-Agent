import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DEMO, api } from '../api.js';
import { Button } from './ui.jsx';

/**
 * "Apply the suggested fix" for a test the AI's reading blamed on how it was written (or that passed only on a
 * second try): the judge's model proposes a better goal, the person edits it if they like and saves it to the
 * suite. Only the goal changes, never the checks, so a fix cannot hide a regression. Saving clears the old
 * recording: the next run records the new way.
 */

/** Same rule as the server's canFixGoal, without loading it into the page. */
export const canFixGoal = (/** @type {any} */ r) =>
  !!r.test.goal?.trim() &&
  ((r.verdict.status === 'fail' && r.explanation?.category === 'test-problem') ||
    !!r.retry?.passed);

/** @param {{ runId: string, result: any }} props */
export function GoalFix({ runId, result }) {
  const [state, setState] = useState(
    /** @type {'idle' | 'asking' | 'saving' | 'saved'} */ ('idle'),
  );
  const [fix, setFix] = useState(/** @type {any} */ (null));
  const [goal, setGoal] = useState('');
  if (DEMO || !canFixGoal(result)) return null;

  const ask = async () => {
    setState('asking');
    try {
      const f = await api.goalFix(runId, result.test.id);
      setFix(f);
      setGoal(f.goal);
    } catch (e) {
      toast.error(e.message);
    }
    setState('idle');
  };
  const save = async () => {
    setState('saving');
    try {
      const suite = await api.suite(fix.suite);
      const body = suite.suite ?? suite;
      const test = body.tests.find((t) => t.id === result.test.id);
      if (!test) throw new Error(`“${result.test.title}” is not in the suite ${fix.suite}`);
      test.goal = goal.trim();
      // its old steps reach the goal the old way: drop them so the agent records the new way
      delete test.steps;
      await api.saveSuite(fix.suite, body);
      toast.success('Saved to the suite. Its next run records the new way with the agent.');
      setState('saved');
    } catch (e) {
      toast.error(e.message);
      setState('idle');
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(goal);
      toast.success('Copied the new goal');
    } catch {
      toast.error('The browser did not allow copying');
    }
  };

  if (!fix)
    return (
      <div>
        <Button variant="secondary" busy={state === 'asking'} onClick={ask}>
          <Sparkles size={14} aria-hidden /> Suggest a better goal
        </Button>
        <p className="mt-1 text-[12px] text-muted">
          Rewrites how the test reaches its goal. Its checks stay exactly as they are.
        </p>
      </div>
    );
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line px-3.5 py-3 text-[13px]">
      <p className="font-semibold">A better goal</p>
      <p className="text-muted">
        <span className="font-medium text-text">Before: </span>
        {fix.old}
      </p>
      <label className="flex flex-col gap-1">
        <span className="font-medium">After (you can edit it)</span>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          className="rounded-lg border border-line bg-bg px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:border-user"
        />
      </label>
      <p className="text-muted">{fix.changed}</p>
      <div className="flex flex-wrap items-center gap-2">
        {fix.suite ? (
          <Button
            variant="accent"
            busy={state === 'saving'}
            disabled={state === 'saved' || !goal.trim()}
            onClick={save}
          >
            {state === 'saved' ? 'Saved' : `Save to suite ${fix.suite}`}
          </Button>
        ) : (
          <span className="text-[12px] text-muted">
            This run was planned by the AI: save it as a suite to keep a reworded test.
          </span>
        )}
        <Button variant="secondary" onClick={copy}>
          Copy
        </Button>
      </div>
    </div>
  );
}
