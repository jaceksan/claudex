import { useEffect } from 'react';
import { Route, Link } from 'wouter';
import DashboardPage from './pages/dashboard';
import SessionPage from './pages/session';
import { Toaster } from './components/toaster';
import { useSessionList } from './hooks/use-ws';

export default function App() {
  const sessions = useSessionList();
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
      </header>
      <main className="flex-1 overflow-hidden">
        <Route path="/" component={DashboardPage} />
        <Route path="/session/:id">{(params) => <SessionPage id={params.id} />}</Route>
      </main>
      <Toaster />
    </div>
  );
}
