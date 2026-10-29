import { useState } from 'react';
import { Badge, SectionTitle } from './ui.jsx';

const PREVIEW = 4;
const isColor = (prop) => prop === 'color' || prop === 'background' || prop === 'border';
const Swatch = ({ value }) => (
  <span
    className="inline-block size-3 shrink-0 translate-y-0.5 rounded-sm border border-line"
    style={{ background: value }}
    aria-hidden
  />
);

/**
 * Run-level: do the same kinds of element (buttons, links, inputs, headings, named components) look
 * the same on every screen the run reached? Advisory: it never changes a verdict.
 */
export function Consistency({ consistency }) {
  const [all, setAll] = useState(false);
  const { states, themes, findings } = consistency;
  const shown = all ? findings : findings.slice(0, PREVIEW);
  return (
    <section className="rounded-xl border border-line bg-panel p-5 shadow-[var(--shadow)]">
      <SectionTitle
        aside={`${states} screen${states === 1 ? '' : 's'} · ${themes.length} theme${themes.length === 1 ? '' : 's'} · advisory`}
      >
        Consistency across screens
      </SectionTitle>
      {findings.length === 0 ? (
        <p className="text-[13px] text-ok">
          No drift: every kind of element looks the same wherever it appears.
        </p>
      ) : (
        <>
          <p className="mb-3 max-w-3xl text-[13px] text-muted">
            Looks of the same element that differ only slightly are probably meant to be one (a
            component that drifted). Elements marked{' '}
            <code className="font-mono text-[12px]">data-aie2e-component</code> must look the same
            everywhere. This never changes a test verdict.
          </p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {shown.map((f, i) => (
              <li
                key={i}
                className="grid gap-2 px-4 py-3 text-[13px] md:grid-cols-[180px_minmax(0,1fr)]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warn">
                    {f.type === 'near-duplicate' ? 'Near-duplicate' : 'Component varies'}
                  </Badge>
                  <span className="font-medium">{f.component ?? f.kind}</span>
                  <span className="text-[12px] capitalize text-muted">{f.theme}</span>
                </div>
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {f.diffs.map((d) => (
                      <span key={d.prop} className="font-mono text-[12px]">
                        {d.prop} {isColor(d.prop) && <Swatch value={d.a} />} {d.a}
                        <span className="text-muted"> vs </span>
                        {isColor(d.prop) && <Swatch value={d.b} />} {d.b}
                        {d.deltaE !== undefined && (
                          <span className="text-muted"> · ΔE {d.deltaE}</span>
                        )}
                      </span>
                    ))}
                  </div>
                  {f.styles.map((s, k) => (
                    <div
                      key={k}
                      className="truncate font-mono text-[11px] text-muted"
                      title={JSON.stringify(s.style)}
                    >
                      {s.pages.join(', ')} · {s.example.selector}
                      {s.example.text && ` "${s.example.text}"`} × {s.count}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {findings.length > PREVIEW && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="mt-3 text-[13px] font-medium text-user hover:underline"
            >
              {all ? 'Show fewer' : `Show all ${findings.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
