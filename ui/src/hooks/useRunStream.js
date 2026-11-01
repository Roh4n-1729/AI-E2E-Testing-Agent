import { useEffect, useReducer, useRef, useState } from 'react';
import { initial, reduce } from './runReducer.js';

const TYPES = [
  'run.started',
  'phase',
  'site.ready',
  'plan.review',
  'plan.reused',
  'plan.ready',
  'screens.found',
  'plan.extended',
  'test.started',
  'test.step',
  'test.screenshot',
  'test.judging',
  'test.finished',
  'log',
  'run.finished',
  'run.error',
];

export function useRunStream(runId) {
  const [state, dispatch] = useReducer(reduce, initial);
  const [frames, setFrames] = useState({});
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(0);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);
    const seen = (e) => {
      const seq = Number(e.lastEventId || 0);
      if (seq && seq <= lastSeq.current) return false;
      if (seq) lastSeq.current = seq;
      return true;
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    for (const type of TYPES) {
      es.addEventListener(type, (e) => {
        if (!seen(e)) return;
        dispatch({ type, data: JSON.parse(e.data) });
        if (type === 'run.finished' || type === 'run.error') es.close();
      });
    }
    // Frames arrive at up to ~30/s: keep only the newest per test and paint once per display frame.
    const latest = {};
    let raf = 0;
    es.addEventListener('frame', (e) => {
      const d = JSON.parse(e.data);
      latest[d.testId] = `data:image/jpeg;base64,${d.jpeg}`;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setFrames((f) => ({ ...f, ...latest }));
        });
    });
    return () => {
      es.close();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [runId]);

  return { state, frames, connected };
}
