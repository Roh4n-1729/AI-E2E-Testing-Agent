import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

const SNIPPET = `<!-- 1. Stable selectors: recordings use these instead of brittle XPaths -->
<button data-testid="export-button">Export</button>

<!-- 2. Say when you are busy: the harness waits until it clears -->
<main aria-busy="true">Generating slides…</main>

<!-- 3. Hidden until hover? Tell the agent how to reveal it -->
<div class="present-toolbar"
     data-aie2e-reveal="hover"
     data-aie2e-hint="Controls appear when the mouse moves to the bottom-right corner">
  <button data-testid="present-next">Next</button>
</div>

<!-- 4. Conditional controls: explain the condition -->
<button data-testid="publish" data-aie2e-hint="Enabled only after the deck has a title">
  Publish
</button>`;

const ROWS = [
  [
    'data-testid',
    'Also data-test, data-cy, data-qa.',
    'Recordings use it instead of an XPath, so replays survive layout changes. The agent can act on it exactly, and the planner may assert on it.',
  ],
  [
    'aria-busy="true"',
    'A standard ARIA attribute.',
    'The harness waits for it to clear before replaying the next step or judging, so slow or streaming screens are not judged half-done.',
  ],
  [
    'data-aie2e-hint',
    'Free text for the tester.',
    'Shown to the planner and the agent. Use it for hover-only controls, conditions and shortcuts.',
  ],
  [
    'data-aie2e-reveal="hover"',
    'Marks a hidden control.',
    'The agent knows the control exists and that it has to hover to reveal it.',
  ],
];

export function Hints() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mx-auto max-w-[820px] space-y-6">
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">App hints</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Nothing here is required: without hints the agent works from what it sees, and recordings
          use XPaths. A few attributes make runs cheaper and replays sturdier, and help with
          hover-only or conditional controls that are hard to find by looking.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <table className="w-full text-left text-[13px]">
          <thead className="text-[12px] text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 font-medium">Attribute</th>
              <th className="px-4 py-2.5 font-medium">What it changes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ROWS.map(([attr, note, effect]) => (
              <tr key={attr} className="align-top">
                <td className="whitespace-nowrap px-4 py-3">
                  <code className="font-mono text-[12px] text-user">{attr}</code>
                  <div className="mt-0.5 text-[12px] text-muted">{note}</div>
                </td>
                <td className="px-4 py-3 text-muted">{effect}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex items-center border-b border-line px-4 py-2 text-[12px] text-muted">
          Example markup
          <button
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-subtle hover:text-text"
            onClick={async () => {
              await navigator.clipboard.writeText(SNIPPET).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}{' '}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed">{SNIPPET}</pre>
      </div>
    </div>
  );
}
