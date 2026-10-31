import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { api } from './api.js';
import { AppShell } from './components/AppShell.jsx';
import { useHashRoute } from './hooks/useHashRoute.js';
import { Hints } from './screens/Hints.jsx';
import { NewRun } from './screens/NewRun.jsx';
import { Recordings } from './screens/Recordings.jsx';
import { RunView } from './screens/RunView.jsx';
import { Runs } from './screens/Runs.jsx';
import { Suites } from './screens/Suites.jsx';

export function App() {
  const route = useHashRoute();
  const [health, setHealth] = useState(null);
  // refreshed on every screen change and every few seconds while a run is going, so the sidebar shows
  // the running run's models and goes back to the defaults when it ends
  const active = health?.active;
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .health()
        .then((h) => live && setHealth(h))
        .catch(() => live && setHealth(null));
    load();
    const timer = active ? setInterval(load, 5000) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [route.name, route.id, active]);

  return (
    <AppShell route={route} health={health}>
      {route.name === 'new' && <NewRun health={health} />}
      {route.name === 'runs' && <Runs />}
      {route.name === 'run' && (
        <RunView key={route.id} id={route.id} test={route.test} visual={route.visual} />
      )}
      {route.name === 'recordings' && <Recordings id={route.id} />}
      {route.name === 'suites' && <Suites name={route.id} />}
      {route.name === 'hints' && <Hints />}
      <Toaster position="bottom-right" theme="system" richColors closeButton />
    </AppShell>
  );
}
