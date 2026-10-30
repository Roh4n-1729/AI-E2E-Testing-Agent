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
  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

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
