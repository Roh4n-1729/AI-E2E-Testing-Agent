import { Bot, Check, ChevronDown, Gavel, MousePointerClick, X } from 'lucide-react';
import { useState } from 'react';
import { describeExpectation, fmtTokens, shortUrl } from '../lib/format.js';

/**
 * Three parts of the tool work on every test, and each gets its own input:
 *  - the AI agent gets a goal (and the instruction around it) and drives the browser;
 *  - Playwright gets steps (written by a person, or recorded from the agent) and collects the evidence;
 *  - the judge gets checks and decides pass or fail from that evidence alone.
 * This view shows, for one test, what each was given, who wrote it, and what each did.
 */

export const ACTORS = {
  agent: { label: 'AI agent', Icon: Bot, tone: 'text-ai', bg: 'bg-ai/10', ring: 'border-ai/30' },
  playwright: {
    label: 'Playwright',
    Icon: MousePointerClick,
    tone: 'text-user',
    bg: 'bg-user/10',
    ring: 'border-user/30',
  },
  judge: {
    label: 'Judge',
    Icon: Gavel,
    tone: 'text-text',
    bg: 'bg-subtle',
    ring: 'border-line-strong',
  },
};

const short = (m) => String(m ?? '').replace(/^[a-z]+\//, '');
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** Who wrote the test's goal and checks. */
export function testAuthor(test, report, options) {
  switch (test.origin) {
    case 'planner':
      return `Written by the AI planner${report.models ? ` (${short(report.models.planner)})` : ''}`;
    case 'suite':
      return `From your suite${options?.suiteName ? ` “${options.suiteName}”` : ''}`;
    case 'user':
      return 'Typed in when the run was started';
    case 'smoke':
      return 'The built-in page check';
    default:
      return test.tags?.includes('smoke') ? 'The built-in page check' : 'Planned for this run';
  }
}

function playwrightAuthor(pw) {
  switch (pw?.source) {
    case 'suite':
      return 'From your suite (written by a person, or saved from an earlier run)';
    case 'recording':
      return `Recorded by the AI agent${pw.recordedAt ? ` on ${when(pw.recordedAt)}` : ' in an earlier run'}`;
    case 'agent':
      return 'Recorded from the AI agent’s actions in this run';
    default:
      return 'Only the page to open: no steps';
  }
}

/** One recorded step as Playwright runs it. */
function stepParts(s) {
  switch (s.kind) {
    case 'navigate':
      return ['open', shortUrl(s.url), ''];
    case 'back':
      return ['go back', '', ''];
    case 'wait':
      return ['wait', '', `${s.arguments?.[0] ?? ''} ms`];
    case 'mouse':
      return ['move mouse', `${s.arguments?.[0]}%, ${s.arguments?.[1]}% of the window`, ''];
    default:
      return [s.method ?? 'click', s.selector ?? '', (s.arguments ?? []).join(', ')];
  }
}

function Author({ children }) {
  return (
    <span className="rounded-md bg-subtle px-2 py-0.5 text-[12px] font-medium text-muted">
      {children}
    </span>
  );
}

function Block({ title, author, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {author && <Author>{author}</Author>}
      </div>
      {children}
    </div>
  );
}

function AgentInput({ result, report, options }) {
  const a = result.inputs?.agent;
  const [open, setOpen] = useState(false);
  const tokens = (result.llmUsage?.inputTokens ?? 0) + (result.llmUsage?.outputTokens ?? 0);
  if (!a)
    return (
      <p className="text-[14px] text-muted">
        {result.test.goal
          ? 'The AI agent was not needed: Playwright replayed the steps, with no AI calls.'
          : 'No AI agent: this test only opens the page and checks it.'}
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      <Block title="Goal" author={testAuthor(result.test, report, options)}>
        <p className="text-[15px] leading-relaxed">{result.test.goal}</p>
      </Block>
      <Block title="Model">
        <p className="text-[14px]">
          {short(a.model)} {a.engine === 'loop' ? '(own agent loop)' : '(Stagehand agent)'}
          {tokens > 0 && (
            <span className="text-muted">, {fmtTokens(tokens)} tokens in this test</span>
          )}
        </p>
      </Block>
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-[13px] font-medium text-user hover:underline"
        >
          <ChevronDown size={14} className={open ? 'rotate-180' : ''} aria-hidden />
          {open ? 'Hide' : 'Show'} the full instruction the agent received
        </button>
        {open && (
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-subtle p-3 font-mono text-[12px] leading-relaxed">
            {a.instruction}
          </pre>
        )}
      </div>
      {result.agentClaim && (
        <Block title="What it reported" author="Never used for the result">
          <p className="text-[14px] text-muted">“{result.agentClaim.message}”</p>
        </Block>
      )}
    </div>
  );
}

function PlaywrightInput({ result }) {
  const pw = result.inputs?.playwright;
  const steps = (pw?.steps ?? []).filter((s, i) => !(i === 0 && s.kind === 'navigate'));
  const e = result.evidence;
  const evidence = [
    [e.screenshots?.length ?? 0, 'screenshot', 'screenshots'],
    [(e.requests ?? []).filter((r) => r.api).length, 'API call watched', 'API calls watched'],
    [
      e.console.filter((c) => c.type === 'error' || c.type === 'pageerror').length,
      'console error',
      'console errors',
    ],
    [e.networkFailures.length, 'failed request', 'failed requests'],
    [e.visual?.captures?.length ?? 0, 'screen compared', 'screens compared'],
  ];
  return (
    <div className="flex flex-col gap-4">
      <Block title={`Steps (${steps.length})`} author={playwrightAuthor(pw)}>
        {steps.length === 0 ? (
          <p className="text-[14px] text-muted">
            {result.mode === 'agent'
              ? 'The agent’s actions could not be saved as steps this time, so the next run uses the agent again.'
              : 'Playwright only opened the start page.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[560px] border-collapse text-[13px]">
              <thead>
                <tr className="bg-subtle text-left text-[12px] text-muted">
                  <th scope="col" className="w-10 px-3 py-2 font-medium">
                    #
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Step
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Action
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    On
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {steps.map((s, i) => {
                  const [action, target, value] = stepParts(s);
                  return (
                    <tr key={i} className="align-top">
                      <td className="px-3 py-2 text-muted">{i + 1}</td>
                      <td className="px-3 py-2">{s.description}</td>
                      <td className="px-3 py-2 font-medium">{action}</td>
                      <td className="max-w-[280px] break-all px-3 py-2 font-mono text-[12px] text-muted">
                        {target}
                      </td>
                      <td className="px-3 py-2 font-mono text-[12px]">{value}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Block>
      <Block title="Evidence it collected for the judge">
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[14px]">
          {evidence.map(([n, one, many]) => (
            <li key={many}>
              <span className="font-semibold">{n}</span>{' '}
              <span className="text-muted">{n === 1 ? one : many}</span>
            </li>
          ))}
        </ul>
      </Block>
    </div>
  );
}

function JudgeInput({ result, report, options }) {
  const own = new Set(result.test.expectations.map((e) => JSON.stringify(e)));
  const checks = result.verdict.checks;
  // the error guards are added to every test by the tool, whoever wrote the rest
  const isOwn = (c) =>
    own.has(JSON.stringify(c.expectation)) && !GUARD_KINDS.has(c.expectation.kind);
  const written = checks.filter(isOwn);
  const added = checks.filter((c) => !isOwn(c));
  const Row = ({ c }) => (
    <li className="flex items-start gap-2.5 py-2">
      {c.passed ? (
        <Check size={15} className="mt-0.5 shrink-0 text-ok" aria-label="held" />
      ) : (
        <X
          size={15}
          className={`mt-0.5 shrink-0 ${c.advisory ? 'text-warn' : 'text-bad'}`}
          aria-label="did not hold"
        />
      )}
      <div className="min-w-0">
        <div className="text-[14px]">
          {c.expectation.label ?? describeExpectation(c.expectation)}
        </div>
        {c.expectation.label && (
          <div className="break-all font-mono text-[12px] text-muted">
            {describeExpectation(c.expectation)}
          </div>
        )}
        <div className="text-[12px] text-muted">
          {c.detail}
          {c.vacuous && ' '}
        </div>
      </div>
    </li>
  );
  return (
    <div className="flex flex-col gap-4">
      <Block
        title={`Checks for this test (${written.length})`}
        author={testAuthor(result.test, report, options)}
      >
        <ul className="divide-y divide-line">
          {written.map((c, i) => (
            <Row key={i} c={c} />
          ))}
        </ul>
      </Block>
      {added.length > 0 && (
        <Block
          title={`Checks the tool adds to every test (${added.length})`}
          author="Errors always count; quality and looks are advisory unless set to fail"
        >
          <ul className="divide-y divide-line">
            {added.map((c, i) => (
              <Row key={i} c={c} />
            ))}
          </ul>
        </Block>
      )}
      <Block title="Decision">
        <p className="text-[14px]">
          {result.verdict.status === 'pass'
            ? 'Passed: every check held, from evidence Playwright collected.'
            : result.verdict.status === 'error'
              ? 'Could not decide: the test did not run.'
              : 'Failed: at least one check did not hold.'}{' '}
          <span className="text-muted">
            The AI agent’s report is not an input.
            {result.explanation ? ' The AI’s reading was written after this decision.' : ''}
          </span>
        </p>
      </Block>
    </div>
  );
}

/** The filter: everything, or one part of the tool with its input. */
export function ActorFilter({ value, onChange, result }) {
  const agentSteps = (result.trace ?? []).filter((t) => t.source === 'agent' && !t.observe).length;
  const pwSteps = (result.trace ?? []).filter((t) => t.source !== 'agent').length;
  const opts = [
    ['all', 'Everything', null],
    ['agent', ACTORS.agent.label, result.inputs?.agent ? agentSteps : 0],
    ['playwright', ACTORS.playwright.label, pwSteps],
    ['judge', ACTORS.judge.label, result.verdict.checks.length],
  ];
  return (
    <div role="tablist" aria-label="Show the part of the tool" className="flex flex-wrap gap-1.5">
      {opts.map(([k, label, n]) => {
        const A = ACTORS[k];
        const on = value === k;
        return (
          <button
            key={k}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(k)}
            className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors ${
              on ? 'border-text bg-text text-bg' : 'border-line-strong bg-panel hover:bg-subtle'
            }`}
          >
            {A && <A.Icon size={14} className={on ? '' : A.tone} aria-hidden />}
            {label}
            {n != null && <span className="font-normal opacity-70">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

const TITLE = {
  agent: 'What the AI agent was given',
  playwright: 'What Playwright was given',
  judge: 'What the judge was given',
};
const GUARD_KINDS = new Set(['no-console-errors', 'no-network-failures']);

/** What one part was given and who wrote it. */
export function ActorInput({ actor, result, report, options }) {
  const A = ACTORS[actor];
  const intro = {
    agent:
      'Gets a goal in plain English, drives the browser like a person, and reports what it thinks happened.',
    playwright:
      'Runs exact steps with no AI (a replay) or carries out the agent’s actions, and collects the evidence: pages, screenshots, requests, console.',
    judge:
      'Gets the checks and decides pass or fail from Playwright’s evidence alone. Same input, same decision, every time.',
  }[actor];
  return (
    <section className={`flex flex-col gap-4 rounded-xl border bg-panel p-5 ${A.ring}`}>
      <div className="flex items-start gap-3">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${A.bg}`}>
          <A.Icon size={18} className={A.tone} aria-hidden />
        </span>
        <div>
          <h2 className="text-[16px] font-semibold">{TITLE[actor]}</h2>
          <p className="text-[13px] text-muted">{intro}</p>
        </div>
      </div>
      {actor === 'agent' && <AgentInput result={result} report={report} options={options} />}
      {actor === 'playwright' && <PlaywrightInput result={result} />}
      {actor === 'judge' && <JudgeInput result={result} report={report} options={options} />}
    </section>
  );
}
