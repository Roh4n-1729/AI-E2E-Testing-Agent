import {
  Activity,
  BookOpen,
  Film,
  History,
  ListChecks,
  Monitor,
  Moon,
  Play,
  Sun,
} from 'lucide-react';
import { useTheme } from '../lib/theme.js';
import { Tooltip } from './ui.jsx';

/** "anthropic/claude-haiku-4-5" -> "claude-haiku-4-5" */
const short = (m) => String(m ?? '').replace(/^[a-z]+\//, '');

const NAV = [
  { name: 'new', href: '#/new', label: 'New run', icon: Play },
  { name: 'runs', href: '#/runs', label: 'Runs', icon: History },
  { name: 'suites', href: '#/suites', label: 'Test suites', icon: ListChecks },
  { name: 'recordings', href: '#/recordings', label: 'Recordings', icon: Film },
  { name: 'hints', href: '#/hints', label: 'App hints', icon: BookOpen },
];

function ThemeSwitch() {
  const [pref, setPref] = useTheme();
  const opts = [
    ['system', Monitor, 'Match the system'],
    ['light', Sun, 'Light'],
    ['dark', Moon, 'Dark'],
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex rounded-lg border border-line bg-subtle p-0.5"
    >
      {opts.map(([v, Icon, label]) => (
        <Tooltip key={v} content={label}>
          <button
            role="radio"
            aria-checked={pref === v}
            aria-label={label}
            onClick={() => setPref(v)}
            className={`flex h-6 flex-1 items-center justify-center rounded-md ${pref === v ? 'bg-panel text-text shadow-sm' : 'text-faint hover:text-text'}`}
          >
            <Icon size={13} aria-hidden />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/** App frame: sidebar on desktop, a compact top bar on small screens. */
export function AppShell({ route, health, children }) {
  const active = route.name === 'run' ? 'runs' : route.name;
  const link = (n, compact) => {
    const Icon = n.icon;
    const on = active === n.name;
    return (
      <a
        key={n.name}
        href={n.href}
        aria-current={on ? 'page' : undefined}
        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
          on ? 'bg-user/10 font-semibold text-user' : 'text-muted hover:bg-panel/60 hover:text-text'
        } ${compact ? 'shrink-0' : ''}`}
      >
        <Icon size={15} strokeWidth={1.75} aria-hidden />
        {n.label}
      </a>
    );
  };
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-[224px] shrink-0 flex-col border-r border-line bg-subtle/60 px-3 py-4 md:flex">
        <a
          href="#/new"
          className="mb-6 flex items-center gap-2 px-2 text-[15px] font-semibold tracking-tight"
        >
          <span className="flex size-7 items-center justify-center rounded-lg bg-text text-bg">
            <Activity size={15} strokeWidth={2.25} aria-hidden />
          </span>
          AI E2E Agent
        </a>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {NAV.map((n) => link(n, false))}
        </nav>
        <div className="mt-auto space-y-3 px-1">
          {health && (
            <div className="space-y-1.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-[12px] text-muted">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-text">
                  Models
                  {health.preset
                    ? ` · ${health.preset[0].toUpperCase()}${health.preset.slice(1)}`
                    : ''}
                </span>
                <Tooltip
                  content={
                    health.keyPresent
                      ? `${health.keyVar ?? 'API key'} is set`
                      : `Set ${health.keyVar ?? 'an API key'} in .env`
                  }
                >
                  <span
                    className={`size-1.5 rounded-full ${health.keyPresent ? 'bg-ok' : 'bg-warn'}`}
                    aria-label={health.keyPresent ? 'API key found' : 'No API key'}
                  />
                </Tooltip>
              </div>
              {(health.plannerModel === health.judgeModel
                ? [
                    ['agent', health.model],
                    ['planner and judge', health.plannerModel],
                  ]
                : [
                    ['agent', health.model],
                    ['planner', health.plannerModel],
                    ['judge', health.judgeModel],
                  ]
              ).map(([role, m]) => (
                <div key={role} className="min-w-0" title={m}>
                  <div className="text-[11px]">{role}</div>
                  <div className="truncate font-mono text-[11px] text-text">{short(m)}</div>
                </div>
              ))}
              {!health.keyPresent && <div className="text-warn">No API key: replays only</div>}
            </div>
          )}
          <ThemeSwitch />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-2 overflow-x-auto border-b border-line bg-bg/90 px-4 py-2 backdrop-blur md:hidden">
          {NAV.map((n) => link(n, true))}
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
