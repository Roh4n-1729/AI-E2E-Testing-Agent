import { Expand } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import Thumbnails from 'yet-another-react-lightbox/plugins/thumbnails';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import 'yet-another-react-lightbox/plugins/thumbnails.css';
import { fileUrl } from '../api.js';
import { shortUrl } from '../lib/format.js';

/**
 * One lightbox per test: every screenshot (harness and agent) as a zoomable slideshow with
 * thumbnails, captions and keyboard navigation. Thumbnails anywhere in the test open it at
 * their own frame, so screenshots never open in a new tab.
 */
const Ctx = createContext({ open: () => {} });

const SOURCE = { harness: 'Captured by the test harness', agent: 'Captured during the agent run' };

export function EvidenceGallery({ runId, shots, captions = {}, children }) {
  const [index, setIndex] = useState(-1);
  const slides = useMemo(
    () =>
      shots.map((s, i) => ({
        src: fileUrl(runId, s.path),
        title: `${i + 1} / ${shots.length}  ${captions[s.path] ?? labelFor(s)}`,
        description: `${SOURCE[s.source] ?? s.source} · ${shortUrl(s.url)}`,
        path: s.path,
      })),
    [runId, shots, captions],
  );
  const open = useCallback(
    (path) =>
      setIndex(
        Math.max(
          0,
          slides.findIndex((s) => s.path === path),
        ),
      ),
    [slides],
  );
  return (
    <Ctx.Provider value={{ open }}>
      {children}
      <Lightbox
        open={index >= 0}
        index={index}
        close={() => setIndex(-1)}
        slides={slides}
        plugins={[Zoom, Thumbnails, Captions]}
        zoom={{ maxZoomPixelRatio: 3, scrollToZoom: true }}
        thumbnails={{ width: 112, height: 70, border: 1, borderRadius: 6, padding: 0, gap: 8 }}
        captions={{ descriptionTextAlign: 'start', descriptionMaxLines: 2 }}
        carousel={{ finite: true }}
        controller={{ closeOnBackdropClick: true }}
      />
    </Ctx.Provider>
  );
}

function labelFor(s) {
  if (s.label === 'start') return 'Start page';
  if (s.label === 'final') return 'Final state (judged)';
  if (s.label === 'resume') return 'Agent takes over after the replay broke';
  if (s.label.startsWith('step-')) return `After replay step ${s.label.slice(5)}`;
  if (s.label.startsWith('theme:')) return `Theme "${s.label.slice(6)}"`;
  if (s.label.startsWith('crop:')) return s.label.slice(5);
  if (s.label.startsWith('visual:')) return s.label.slice(7);
  return 'During the run';
}

/** A screenshot thumbnail that opens the gallery at this frame. */
export function Shot({ runId, path, alt, className = '', highlight = false }) {
  const { open } = useContext(Ctx);
  return (
    <button
      type="button"
      onClick={() => open(path)}
      className={`group relative block shrink-0 overflow-hidden rounded-lg border bg-canvas transition-colors ${highlight ? 'border-user/60' : 'border-line hover:border-line-strong'} ${className}`}
      aria-label={`Open screenshot: ${alt}`}
    >
      <img
        src={fileUrl(runId, path)}
        alt={alt}
        loading="lazy"
        className="block h-full w-full object-cover object-top"
      />
      <span className="absolute right-1.5 top-1.5 rounded-md bg-black/55 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100">
        <Expand size={12} aria-hidden />
      </span>
    </button>
  );
}
