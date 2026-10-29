import { useEffect, useState } from 'react';

/** Tiny hash router: '#/runs/abc' -> { name: 'run', id: 'abc' }. No dependency needed for 5 pages. */
function parse(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'runs' && parts[1]) return { name: 'run', id: parts[1] };
  if (parts[0] === 'runs') return { name: 'runs' };
  if (parts[0] === 'recordings') return { name: 'recordings', id: parts[1] };
  if (parts[0] === 'hints') return { name: 'hints' };
  if (parts[0] === 'suites') return { name: 'suites', id: parts[1] };
  return { name: 'new' };
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
