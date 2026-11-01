import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { Select as S, Switch as Sw, Tabs as T, Tooltip as Tip } from 'radix-ui';

/**
 * Primitives. Interactive ones are Radix (accessible, keyboard-complete, MIT) styled with our
 * tokens: the shadcn approach, written by hand. Colour carries status; indigo = user, saffron = AI.
 */

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  busy = false,
  children,
  ...rest
}) {
  const sizes = { sm: 'h-7 px-2.5 text-[12px] gap-1.5', md: 'h-9 px-3.5 text-[13px] gap-2' };
  const styles = {
    primary: 'bg-text text-bg hover:opacity-90',
    accent: 'bg-user text-white hover:opacity-90 dark:text-[#0d121c]',
    secondary: 'bg-panel text-text border border-line hover:border-line-strong hover:bg-subtle',
    danger: 'bg-bad-bg text-bad border border-bad/25 hover:border-bad/50',
    ghost: 'text-muted hover:bg-subtle hover:text-text',
  };
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${sizes[size]} ${styles[variant]} ${className}`}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function LinkButton({ className = '', children, ...rest }) {
  return (
    <a
      className={`inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3.5 text-[13px] font-medium text-text transition-colors hover:border-line-strong hover:bg-subtle ${className}`}
      {...rest}
    >
      {children}
    </a>
  );
}

const TONES = {
  neutral: 'bg-subtle text-muted border-line',
  ok: 'bg-ok-bg text-ok border-ok/25',
  bad: 'bg-bad-bg text-bad border-bad/25',
  warn: 'bg-warn-bg text-warn border-warn/25',
  ai: 'bg-ai/10 text-ai border-ai/25',
  user: 'bg-user/10 text-user border-user/25',
};

export function Badge({ tone = 'neutral', title, className = '', children }) {
  const el = (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-px text-[11px] font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
  return title ? <Tooltip content={title}>{el}</Tooltip> : el;
}

const DOT = {
  ok: 'bg-ok',
  bad: 'bg-bad',
  warn: 'bg-warn',
  ai: 'bg-ai',
  user: 'bg-user',
  neutral: 'bg-faint',
};
export function Dot({ tone = 'neutral', pulse = false }) {
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${DOT[tone]} ${pulse ? 'pulse' : ''}`}
      aria-hidden
    />
  );
}

export function Card({ className = '', children, ...rest }) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, aside }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-[13px] font-semibold text-text">{children}</h3>
      {aside && <div className="ml-auto text-[12px] text-muted">{aside}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
      {Icon && <Icon size={22} className="mb-3 text-faint" aria-hidden />}
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <div className="mt-1.5 max-w-md text-[13px] text-muted">{children}</div>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Kbd({ children }) {
  return (
    <code className="rounded border border-line bg-subtle px-1.5 py-px font-mono text-[12px]">
      {children}
    </code>
  );
}

export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-md bg-subtle ${className}`} />;
}

// ---- Radix wrappers -----------------------------------------------------------------------------

export function Tooltip({ content, children, side = 'top' }) {
  return (
    <Tip.Provider delayDuration={250}>
      <Tip.Root>
        <Tip.Trigger asChild>{children}</Tip.Trigger>
        <Tip.Portal>
          <Tip.Content
            side={side}
            sideOffset={6}
            className="pop-in z-50 max-w-xs rounded-md bg-text px-2.5 py-1.5 text-[12px] text-bg shadow-pop"
          >
            {content}
          </Tip.Content>
        </Tip.Portal>
      </Tip.Root>
    </Tip.Provider>
  );
}

/** Custom dropdown select. options: [{ value, label, hint? }]; disabled: shown but fixed (say why next to it). */
export function Select({ value, onValueChange, options, label, id, disabled = false }) {
  return (
    <S.Root value={String(value)} onValueChange={onValueChange} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={label}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 text-left text-[13px] hover:border-line-strong data-[state=open]:border-user data-[disabled]:cursor-not-allowed data-[disabled]:bg-subtle data-[disabled]:text-muted data-[disabled]:hover:border-line"
      >
        <S.Value />
        <S.Icon>
          <ChevronDown size={15} className="text-faint" aria-hidden />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="pop-in z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-panel p-1 shadow-pop"
        >
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={String(o.value)}
                className="relative flex cursor-default select-none flex-col rounded-md py-1.5 pl-7 pr-3 text-[13px] outline-none data-[highlighted]:bg-subtle"
              >
                <S.ItemIndicator className="absolute left-2 top-2">
                  <Check size={14} className="text-user" aria-hidden />
                </S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
                {o.hint && <span className="text-[12px] text-muted">{o.hint}</span>}
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

export function Switch({ checked, onCheckedChange, label, hint, id }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="text-[12px] text-muted">{hint}</div>}
      </label>
      <Sw.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-user"
      >
        <Sw.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </Sw.Root>
    </div>
  );
}

export const Tabs = T.Root;
export function TabList({ children }) {
  return (
    <T.List className="flex gap-1 overflow-x-auto border-b border-line px-1">{children}</T.List>
  );
}
export function Tab({ value, children, count }) {
  return (
    <T.Trigger
      value={value}
      className="-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-[13px] text-muted hover:text-text data-[state=active]:border-text data-[state=active]:font-medium data-[state=active]:text-text"
    >
      {children}
      {count != null && (
        <span className="rounded bg-subtle px-1 font-mono text-[11px] text-muted">{count}</span>
      )}
    </T.Trigger>
  );
}
export function TabPanel({ value, children, className = '' }) {
  return (
    <T.Content value={value} className={`outline-none ${className}`}>
      {children}
    </T.Content>
  );
}
