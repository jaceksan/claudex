import { useEffect, useState } from 'react';
import { Route, Link } from 'wouter';
import DashboardPage from './pages/dashboard';
import SessionPage from './pages/session';
import TopicPage from './pages/topic';
import { useConnection, useSessionList } from './hooks/use-ws';
import { useNotifications } from './hooks/use-notifications';

function NotificationToggle() {
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    supported ? Notification.permission : 'unsupported',
  );
  if (!supported || perm !== 'default') return null;
  return (
    <button
      type="button"
      onClick={() => {
        Notification.requestPermission()
          .then((p) => setPerm(p))
          .catch(() => {});
      }}
      className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-blue-500 hover:text-blue-300"
      title="Enable desktop notifications"
    >
      🔔 Enable notifications
    </button>
  );
}

export default function App() {
  const sessions = useSessionList();
  const conn = useConnection();
  // Keep OS-notification side-effect alive even though in-app Toaster is removed.
  useNotifications();
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
        <span className="text-xs text-zinc-500">topics &amp; tasks for Claude Code</span>
        <span className="ml-auto flex items-center gap-2 text-xs">
          <NotificationToggle />
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
        <Route path="/topic/:id">{(params) => <TopicPage id={params.id} />}</Route>
      </main>
    </div>
  );
}
