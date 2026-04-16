import { useState } from 'react';
import { Link } from 'wouter';
import { useSessionList, send } from '../hooks/use-ws';
import { useGitInfo } from '../hooks/use-git-info';
import type { SessionState } from '../../server/session/state';
import { LauncherModal } from '../components/launcher';
import { GitBadge } from '../components/git-badge';
import { statusColors } from '../lib/status';

function relativeTime(ts: number): string {
  const rel = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const diffMs = ts - Date.now();
  const seconds = Math.round(diffMs / 1000);
  if (Math.abs(seconds) < 60) return rel.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rel.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return rel.format(hours, 'hour');
}

function SessionCard({ s }: { s: SessionState }) {
  const git = useGitInfo(s.sessionId, 15_000);
  return (
    <Link href={`/session/${s.sessionId}`}>
      <div className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 hover:border-zinc-600 transition">
        <div className="flex items-start justify-between gap-2">
          <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs ring-1 ring-inset ${statusColors[s.status]}`}>
            {s.status}
          </span>
          <span className="text-xs text-zinc-500">{relativeTime(s.lastActivityAt)}</span>
        </div>
        <div className="mt-2 min-w-0">
          {s.title ? (
            <>
              <div className="truncate text-sm font-semibold text-zinc-100" title={s.title}>{s.title}</div>
              <div className="truncate font-mono text-xs text-zinc-500" title={s.cwd}>{s.cwd}</div>
            </>
          ) : (
            <div className="truncate font-mono text-sm text-zinc-300" title={s.cwd}>{s.cwd}</div>
          )}
        </div>
        {git?.isRepo && <div className="mt-1"><GitBadge info={git} compact /></div>}
        <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-zinc-400">
          <div>Tool: <span className="text-zinc-200">{s.currentTool?.name ?? '—'}</span></div>
          <div>Cost: <span className="text-zinc-200">${s.costUsd.toFixed(4)}</span></div>
          <div>Completed: <span className="text-zinc-200">{s.completedTools}</span></div>
          <div>Tokens: <span className="text-zinc-200">{s.tokens.input}/{s.tokens.output}</span></div>
        </div>
        {s.parseErrors > 0 && (
          <div className="mt-2 text-xs text-amber-400">⚠ {s.parseErrors} parse error(s)</div>
        )}
        {s.error && (
          <div className="mt-2 truncate text-xs text-red-400" title={s.error}>{s.error}</div>
        )}
        <div className="mt-2 flex gap-2">
          {s.status === 'detached' && s.claudeSessionId && (
            <button
              onClick={(e) => { e.preventDefault(); send({ type: 'client.resume', payload: { sessionId: s.sessionId } }); }}
              className="rounded bg-purple-600/80 px-2 py-1 text-xs font-medium hover:bg-purple-500"
            >
              Resume
            </button>
          )}
          {s.status === 'detached' && !s.claudeSessionId && (
            <span
              className="rounded bg-amber-900/40 px-2 py-1 text-xs font-medium text-amber-300"
              title="Session predates claude_session_id tracking and can't be resumed. Delete it."
            >
              not resumable
            </span>
          )}
          <button
            onClick={(e) => {
              e.preventDefault();
              if (confirm(`Delete session ${s.sessionId.slice(0, 8)}?`)) {
                send({ type: 'client.delete', payload: { sessionId: s.sessionId } });
              }
            }}
            className="rounded bg-zinc-700/70 px-2 py-1 text-xs font-medium text-zinc-300 hover:bg-red-600 hover:text-white"
          >
            Delete
          </button>
        </div>
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const sessions = useSessionList();
  const [launcherOpen, setLauncherOpen] = useState(false);

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <button
          onClick={() => setLauncherOpen(true)}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500"
        >
          New session
        </button>
      </div>
      {sessions.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-zinc-500">
          No sessions yet — click "New session" to start one
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s) => <SessionCard key={s.sessionId} s={s} />)}
        </div>
      )}
      {launcherOpen && <LauncherModal onClose={() => setLauncherOpen(false)} />}
    </div>
  );
}
