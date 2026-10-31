import { useEffect, useState } from 'react';

/**
 * Tiny hash router: '#/runs/abc' -> { name: 'run', id: 'abc' }; '#/runs/abc/tests/t1?visual' -> the
 * journey of test t1, opened at its visual comparison. No dependency needed for a handful of pages.
 */
export function parse(hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'runs' && parts[1] && parts[2] === 'tests' && parts[3])
    return {
      name: 'run',
      id: parts[1],
      test: decodeURIComponent(parts[3]),
      visual: new URLSearchParams(query).has('visual'),
    };
  if (parts[0] === 'runs' && parts[1]) return { name: 'run', id: parts[1] };
  if (parts[0] === 'runs') return { name: 'runs' };
  if (parts[0] === 'recordings') return { name: 'recordings', id: parts[1] };
  if (parts[0] === 'hints') return { name: 'hints' };
  if (parts[0] === 'suites') return { name: 'suites', id: parts[1] };
  // the showcase opens on the recorded runs: nothing can be started there
  return { name: import.meta.env.MODE === 'demo' && !parts[0] ? 'runs' : 'new' };
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const go = (path) => {
  window.location.hash = path;
};
