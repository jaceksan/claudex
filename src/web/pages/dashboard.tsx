import { useState } from 'react';
import { Link } from 'wouter';
import { useSessionList, send } from '../hooks/use-ws';
import { useGitInfo } from '../hooks/use-git-info';
import type { SessionState } from '../../server/session/state';
import { LauncherModal } from '../components/launcher';
import { BroadcastModal } from '../components/broadcast-modal';
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

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

interface Group {
  /** Stable key for React + grouping. */
  key: string;
  /** Path to display as the card header (worktree origin or the session cwd). */
  repo: string;
  sessions: SessionState[];
}

function groupSessions(sessions: SessionState[]): Group[] {
  const map = new Map<string, Group>();
  for (const s of sessions) {
    const repo = s.worktreeOrigin ?? s.cwd;
    const key = repo;
    let g = map.get(key);
    if (!g) {
      g = { key, repo, sessions: [] };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  // Sort sessions inside each group by recent activity (newest first) so the card top stays useful.
  for (const g of map.values()) g.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  // Sort groups by their most recent session.
  return [...map.values()].sort((a, b) => b.sessions[0].lastActivityAt - a.sessions[0].lastActivityAt);
}

interface RowProps {
  s: SessionState;
  selectMode: boolean;
  selected: boolean;
  onToggle: () => void;
}

function SessionRow({ s, selectMode, selected, onToggle }: RowProps) {
  const isLive = s.status !== 'detached' && s.status !== 'ended' && s.status !== 'crashed';

  const inner = (
    <div
      className={`flex items-center gap-3 rounded px-2 py-2 transition ${
        selected ? 'bg-blue-600/20 ring-1 ring-blue-500/40' : 'hover:bg-zinc-800/60'
      } ${selectMode && !isLive ? 'opacity-50' : ''} cursor-pointer`}
      onClick={(e) => {
        if (!selectMode) return;
        if (!isLive) return;
        e.preventDefault();
        onToggle();
      }}
    >
      {selectMode && (
        <input
          type="checkbox"
          checked={selected}
          disabled={!isLive}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 shrink-0 accent-blue-500"
          title={isLive ? '' : 'Cannot broadcast to a non-active session'}
        />
      )}
      <span className={`shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset ${statusColors[s.status]}`}>
        {s.status}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          {s.worktreeBranch ? (
            <span
              className="shrink-0 truncate max-w-[18ch] rounded bg-emerald-900/40 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300 ring-1 ring-inset ring-emerald-700/60"
              title={s.worktreeBranch}
            >
              🌿 {s.worktreeBranch}
            </span>
          ) : (
            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400" title="Runs in the source working tree (no worktree isolation)">
              main tree
            </span>
          )}
          <span className="truncate text-sm text-zinc-100" title={s.title ?? s.cwd}>
            {s.title ?? <span className="text-zinc-500">(no title)</span>}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-zinc-500">
          <span title="Current tool">{s.currentTool?.name ?? '—'}</span>
          <span>·</span>
          <span title="Cumulative cost">${(s.baselineCostUsd + s.costUsd).toFixed(4)}</span>
          <span>·</span>
          <span title="Cumulative tokens in/out">
            {s.baselineTokens.input + s.tokens.input}/{s.baselineTokens.output + s.tokens.output}
          </span>
          <span>·</span>
          <span title="Completed tools (current subprocess)">{s.completedTools} tools</span>
          <span>·</span>
          <span>{relativeTime(s.lastActivityAt)}</span>
          {s.parseErrors > 0 && (
            <span className="text-amber-400">⚠ {s.parseErrors}</span>
          )}
        </div>
        {s.error && (
          <div className="mt-0.5 truncate text-[11px] text-red-400" title={s.error}>{s.error}</div>
        )}
      </div>
      <div className="flex shrink-0 gap-1.5">
        {s.status === 'detached' && s.claudeSessionId && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); send({ type: 'client.resume', payload: { sessionId: s.sessionId } }); }}
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
            e.stopPropagation();
            const which = s.title || s.worktreeBranch || s.sessionId.slice(0, 8);
            if (confirm(`Delete session ${which}?`)) {
              send({ type: 'client.delete', payload: { sessionId: s.sessionId } });
            }
          }}
          className="rounded bg-zinc-700/70 px-2 py-1 text-xs font-medium text-zinc-300 hover:bg-red-600 hover:text-white"
        >
          Delete
        </button>
      </div>
    </div>
  );

  if (selectMode) return inner;
  return <Link href={`/session/${s.sessionId}`}>{inner}</Link>;
}

interface GroupCardProps {
  group: Group;
  selectMode: boolean;
  selected: Set<string>;
  toggle: (id: string) => void;
}

function GroupCard({ group, selectMode, selected, toggle }: GroupCardProps) {
  // Ask the server about git status using the first session's id. For non-worktree groups
  // (single session) this matches the cwd we display; for worktree groups it reports on
  // whichever worktree session is most recent — fine as a glance signal.
  const git = useGitInfo(group.sessions[0]?.sessionId, 15_000);
  const multi = group.sessions.length > 1 || group.sessions.some((s) => s.worktreeBranch);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-2 flex items-start justify-between gap-2 px-1">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100" title={group.repo}>
            {basename(group.repo)}
          </div>
          <div className="truncate font-mono text-[11px] text-zinc-500" title={group.repo}>
            {group.repo}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {git?.isRepo && <GitBadge info={git} compact />}
          {multi && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300" title="Sessions in this group">
              {group.sessions.length}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {group.sessions.map((s) => (
          <SessionRow
            key={s.sessionId}
            s={s}
            selectMode={selectMode}
            selected={selected.has(s.sessionId)}
            onToggle={() => toggle(s.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const sessions = useSessionList();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [broadcastOpen, setBroadcastOpen] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }

  const groups = groupSessions(sessions);
  const selectedSessions = sessions.filter((s) => selected.has(s.sessionId));

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <div className="flex gap-2">
          {selectMode ? (
            <>
              <span className="self-center text-sm text-zinc-400">
                {selectedSessions.length} selected
              </span>
              <button
                onClick={() => setBroadcastOpen(true)}
                disabled={selectedSessions.length === 0}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500 disabled:opacity-40"
              >
                Broadcast to {selectedSessions.length} session{selectedSessions.length === 1 ? '' : 's'}
              </button>
              <button
                onClick={exitSelect}
                className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setSelectMode(true)}
                disabled={sessions.length === 0}
                className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
              >
                Select
              </button>
              <button
                onClick={() => setLauncherOpen(true)}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500"
              >
                New session
              </button>
            </>
          )}
        </div>
      </div>
      {sessions.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-zinc-500">
          No sessions yet — click "New session" to start one
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {groups.map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              selectMode={selectMode}
              selected={selected}
              toggle={toggle}
            />
          ))}
        </div>
      )}
      {launcherOpen && <LauncherModal onClose={() => setLauncherOpen(false)} />}
      {broadcastOpen && (
        <BroadcastModal
          sessions={selectedSessions}
          onClose={() => { setBroadcastOpen(false); exitSelect(); }}
        />
      )}
    </div>
  );
}
