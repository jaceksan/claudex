import { useEffect } from 'react';
import { Route, Link } from 'wouter';
import DashboardPage from './pages/dashboard';
import SessionPage from './pages/session';
import { Toaster } from './components/toaster';
import { useConnection, useSessionList } from './hooks/use-ws';

export default function App() {
  const sessions = useSessionList();
  const conn = useConnection();
  const running = sessions.filter(
    (s) => s.status === 'running' || s.status === 'starting' || s.status === 'waiting-permission',
  ).length;
  useEffect(() => {
    document.title = running > 0 ? `(${running}) Claudex` : 'Claudex';
  }, [running]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2">
        <Link href="/" className="font-semibold text-lg hover:text-blue-400">claudex</Link>
        <span className="text-xs text-zinc-500">multi-session dashboard</span>
        <span className="ml-auto flex items-center gap-2 text-xs">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              conn === 'open' ? 'bg-green-500' : conn === 'connecting' ? 'bg-amber-500' : 'bg-red-500'
            }`}
          />
          <span className="text-zinc-500">{conn === 'open' ? 'connected' : conn === 'connecting' ? 'connecting…' : 'disconnected'}</span>
        </span>
      </header>
      {conn !== 'open' && (
        <div className={`px-4 py-1 text-xs ${conn === 'connecting' ? 'bg-amber-900/40 text-amber-200' : 'bg-red-900/50 text-red-100'}`}>
          {conn === 'connecting' ? 'Reconnecting to claudex server…' : 'Lost connection to claudex server — will retry automatically.'}
        </div>
      )}
      <main className="flex-1 overflow-hidden">
        <Route path="/" component={DashboardPage} />
        <Route path="/session/:id">{(params) => <SessionPage id={params.id} />}</Route>
      </main>
      <Toaster />
    </div>
  );
}
