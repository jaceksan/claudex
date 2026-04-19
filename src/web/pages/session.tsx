import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { send, subscribe } from '../lib/ws';
import { useConnection, useSessionList } from '../hooks/use-ws';
import { useSessionSiblings } from '../hooks/use-session-siblings';
import type { ServerEnvelope } from '../../server/ws/envelope';
import type { SessionState } from '../../server/session/state';
import type { StreamEvent } from '../../server/stream-json/types';
import { EventView } from '../components/event-view';
import { Composer } from '../components/composer';
import { GitBadge } from '../components/git-badge';
import { useGitInfo } from '../hooks/use-git-info';
import { useTaskContext } from '../hooks/use-task-context';
import { statusColors, isBusy } from '../lib/status';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = typeof EFFORTS[number];

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function ThinkingIndicator({ since, label }: { since: number; label: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  const elapsed = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
  return (
    <div className="flex items-center gap-3 rounded border border-blue-500/20 bg-blue-950/10 px-3 py-2 text-[13px] text-blue-200">
      <span className="inline-flex gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse [animation-delay:300ms]" />
      </span>
      <span>{label}…</span>
      <span className="ml-auto font-mono text-[11px] text-blue-400/70">{elapsed}</span>
    </div>
  );
}

function TaskStatus({ ctx, dirty }: {
  ctx: import('../../server/task-context').TaskContext;
  dirty: import('../../server/git').GitInfo['dirty'];
}) {
  const pending = (dirty?.staged ?? 0) + (dirty?.unstaged ?? 0) + (dirty?.untracked ?? 0);
  const clean = ctx.aheadTopic === 0 && ctx.aheadCanonical === 0 && ctx.behindCanonical === 0 && pending === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-400">
      {clean && <span className="text-emerald-400">✓ clean</span>}
      {ctx.aheadTopic > 0 && (
        <span className="text-emerald-300" title={`${ctx.aheadTopic} commit${ctx.aheadTopic === 1 ? '' : 's'} on this task not yet accepted into the topic branch`}>
          +{ctx.aheadTopic} on task
        </span>
      )}
      {ctx.aheadCanonical > 0 && (
        <span className="text-blue-300" title={`${ctx.aheadCanonical} commit${ctx.aheadCanonical === 1 ? '' : 's'} ahead of the repo's default branch`}>
          +{ctx.aheadCanonical} vs main
        </span>
      )}
      {ctx.behindCanonical > 0 && (
        <span className="text-amber-300" title={`${ctx.behindCanonical} commit${ctx.behindCanonical === 1 ? '' : 's'} on the default branch not yet merged into this task`}>
          -{ctx.behindCanonical} behind main
        </span>
      )}
      {pending > 0 && (
        <span className="text-amber-300" title={`${dirty?.staged ?? 0} staged · ${dirty?.unstaged ?? 0} unstaged · ${dirty?.untracked ?? 0} untracked`}>
          ● {pending} uncommitted
        </span>
      )}
    </div>
  );
}

function handleStream(ev: StreamEvent, buf: string): string {
  if (ev.type !== 'stream_event') return buf;
  const inner = ev.event;
  if (inner.type === 'content_block_start') return '';
  if (inner.type === 'message_start') return '';
  if (inner.type === 'content_block_delta') {
    const d = inner.delta;
    if (d?.type === 'text_delta' && typeof d.text === 'string') return buf + d.text;
    if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') return buf + d.thinking;
  }
  return buf;
}

export default function SessionPage({ id }: { id: string }) {
  const [state, setState] = useState<SessionState | null>(null);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [streaming, setStreaming] = useState<string>('');
  const allSessions = useSessionList();
  const siblingsData = useSessionSiblings(id);
  const sessions = siblingsData
    ? siblingsData.siblings.map((s) => ({
        sessionId: s.sessionId,
        title: s.title ?? s.label,
        cwd: s.cwd,
        status: s.status,
        lastActivityAt: s.lastActivityAt,
      }))
    : allSessions.filter((s) => s.sessionId === id);
  const conn = useConnection();
  const [, navigate] = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);

  // (Re-)subscribe whenever the session id changes OR the WS reconnects after a server restart.
  useEffect(() => {
    if (conn !== 'open') return;
    setStreaming('');
    send({ type: 'client.subscribe', payload: { sessionId: id } });
    return () => {
      send({ type: 'client.unsubscribe', payload: { sessionId: id } });
    };
  }, [id, conn]);

  useEffect(() => {
    const off = subscribe((env: ServerEnvelope) => {
      if (env.type === 'session.replay' && env.payload.state.sessionId === id) {
        setState(env.payload.state);
        setEvents(env.payload.events);
        setStreaming('');
      } else if (env.type === 'session.event' && env.payload.sessionId === id) {
        const ev = env.payload.event;
        if (ev.type === 'stream_event') {
          setStreaming((prev) => handleStream(ev, prev));
        } else {
          if (ev.type === 'assistant' || ev.type === 'user' || ev.type === 'result') {
            setStreaming('');
          }
          setEvents((prev) => [...prev, ev]);
        }
      } else if (
        (env.type === 'session.updated' || env.type === 'session.ended' || env.type === 'session.created')
        && env.payload.state.sessionId === id
      ) {
        setState(env.payload.state);
      } else if (env.type === 'session.deleted' && env.payload.sessionId === id) {
        navigate('/');
      }
    });
    return off;
  }, [id]);

  const detached = state?.status === 'detached';
  const resume = () => send({ type: 'client.resume', payload: { sessionId: id } });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events.length, streaming]);

  const [git, refreshGit] = useGitInfo(state?.sessionId, 10_000);
  const [taskCtx, refreshTaskCtx] = useTaskContext(state?.sessionId, 10_000);

  // Refresh worktree state (dirty / ahead) whenever Claude emits a new event —
  // that's the strongest signal that files on disk may have changed. Debounce so
  // bursts of stream-json events collapse into a single fetch.
  useEffect(() => {
    const t = setTimeout(() => { refreshGit(); refreshTaskCtx(); }, 250);
    return () => clearTimeout(t);
  }, [events.length, refreshGit, refreshTaskCtx]);

  // After a task action, poke the server-side git state a couple of times so
  // the button set updates immediately without waiting for the 10s poll.
  const refreshSoon = () => {
    setTimeout(() => { refreshGit(); refreshTaskCtx(); }, 100);
    setTimeout(() => { refreshGit(); refreshTaskCtx(); }, 700);
  };
  const copy = (text: string) => { navigator.clipboard?.writeText(text).catch(() => {}); };
  const claudeId = state?.claudeSessionId;
  const rename = () => {
    if (!state) return;
    const next = window.prompt('Session title (leave empty to clear):', state.title ?? '');
    if (next === null) return; // cancelled
    send({ type: 'client.rename', payload: { sessionId: id, title: next.trim() || null } });
  };

  const headerInfo = state ? (
    <div className="flex flex-col gap-1 min-w-0">
      {/* Row 1 — identity: status + (for tasks: topic · task, else just title) */}
      <div className="flex items-center gap-2 min-w-0">
        <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${statusColors[state.status]}`}>
          {isBusy(state.status) && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          )}
          {state.status}
        </span>
        {taskCtx ? (
          <div className="flex min-w-0 items-baseline gap-2">
            <Link
              href={`/topic/${taskCtx.topic.id}`}
              className="truncate text-sm font-semibold text-zinc-100 hover:text-blue-300"
              title="Back to topic"
            >
              {taskCtx.topic.title}
            </Link>
            <span className="text-zinc-600">·</span>
            <button
              onClick={rename}
              className="truncate text-sm text-zinc-300 hover:text-blue-300"
              title="Click to rename this task"
            >
              {taskCtx.task.label ?? taskCtx.task.type}
            </button>
          </div>
        ) : state.title ? (
          <button
            onClick={rename}
            className="truncate max-w-md text-sm font-semibold text-zinc-100 hover:text-blue-300"
            title="Click to rename"
          >
            {state.title}
          </button>
        ) : (
          <button
            onClick={rename}
            className="text-xs text-zinc-500 hover:text-blue-300"
            title="Click to set a title"
          >
            + title
          </button>
        )}
      </div>
      {/* Row 2 — status.
          For task sessions: ahead of topic · ahead of upstream default · uncommitted.
          For standalone sessions: location + GitBadge (branch/sha/subject/PR). */}
      <div className="flex flex-wrap items-center gap-2 min-w-0 text-xs">
        {taskCtx ? (
          <TaskStatus ctx={taskCtx} dirty={git?.dirty} />
        ) : (
          <>
            {state.worktreeOrigin ? (
              <span
                className="rounded bg-emerald-900/30 px-1.5 py-0.5 text-[11px] text-emerald-300 ring-1 ring-inset ring-emerald-700/50"
                title={`worktree at ${state.cwd}\noff ${state.worktreeOrigin}`}
              >
                🌿 worktree · {state.worktreeOrigin.split('/').pop()}
              </span>
            ) : (
              <span className="font-mono text-zinc-400 truncate max-w-xl" title={state.cwd}>{state.cwd}</span>
            )}
            {git?.isRepo && <GitBadge info={git} />}
          </>
        )}
      </div>
      {/* Row 2.5 — task actions (task sessions only, while open).
          Buttons are conditional on worktree state so non-tech users aren't
          presented with a noop option:
            - Save / Discard changes: only when the worktree has uncommitted work.
            - Merge to topic / Apply fix: only when the worktree is clean AND the
              task branch is ahead of the topic branch (nothing to merge otherwise).
            - Discard task: always available — it's the escape hatch. */}
      {taskCtx && !taskCtx.task.acceptedAt && !taskCtx.task.discardedAt && (() => {
        const d = git?.dirty;
        const isDirty = !!d && (d.staged + d.unstaged + d.untracked > 0);
        const ahead = taskCtx.aheadTopic;
        const canMerge = !isDirty && ahead > 0;
        return (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {isDirty && (
              <button
                type="button"
                onClick={() => { send({ type: 'client.task.save', payload: { sessionId: id } }); refreshSoon(); }}
                className="rounded bg-blue-700 px-2 py-0.5 text-[11px] text-white hover:bg-blue-600"
                title="Commit uncommitted changes in this worktree"
              >
                Save
              </button>
            )}
            {canMerge && (
              <button
                type="button"
                onClick={() => { send({ type: 'client.task.merge', payload: { sessionId: id } }); refreshSoon(); }}
                className="rounded bg-emerald-700 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-600"
                title={`Merge ${ahead} commit${ahead === 1 ? '' : 's'} into the topic branch`}
              >
                {taskCtx.task.type === 'attempt' ? 'Merge to topic' : 'Apply fix'}
              </button>
            )}
            {isDirty && (
              <button
                type="button"
                onClick={() => {
                  if (confirm('Drop all uncommitted changes? Commits are kept.')) {
                    send({ type: 'client.task.discardChanges', payload: { sessionId: id } });
                    refreshSoon();
                  }
                }}
                className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-amber-600 hover:text-amber-400"
              >
                Discard changes
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (confirm('Discard this task? Kills the session, removes the worktree, and deletes the branch. Unmerged work is lost.')) {
                  send({ type: 'client.task.discardHard', payload: { sessionId: id } });
                  navigate(`/topic/${taskCtx.topic.id}`);
                }
              }}
              className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-red-600 hover:text-red-400"
            >
              Discard task
            </button>
            {!isDirty && ahead === 0 && (
              <span className="text-[11px] text-zinc-600" title="Ask Claude to change files to see Save / Merge options">
                Nothing to save or merge yet.
              </span>
            )}
          </div>
        );
      })()}
      {/* Row 3 — usage stats */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
        <span title="Cumulative cost across all resumes of this session">
          ${(state.baselineCostUsd + state.costUsd).toFixed(4)}
        </span>
        <span className="text-zinc-700">·</span>
        <span title="Cumulative input / output tokens across all resumes">
          {formatTokens(state.baselineTokens.input + state.tokens.input)} in / {formatTokens(state.baselineTokens.output + state.tokens.output)} out
        </span>
        <span className="text-zinc-700">·</span>
        <span title="Completed assistant turns (result events) across all resumes">{state.turns} turns</span>
        <span className="text-zinc-700">·</span>
        <span title="Tool calls completed in the current subprocess">{state.completedTools} tools</span>
      </div>
      {/* Row 4 — config + ids */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
        <label className="inline-flex items-center gap-1" title="Claude effort level — changing this sends /effort to the running session">
          <span>effort:</span>
          <select
            value={state.effort ?? 'medium'}
            onChange={(e) => send({ type: 'client.setEffort', payload: { sessionId: id, effort: e.target.value as EffortLevel } })}
            disabled={state.status === 'ended' || state.status === 'crashed'}
            className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-blue-500 disabled:opacity-50"
          >
            {EFFORTS.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
          </select>
        </label>
        <span className="text-zinc-700">·</span>
        <button
          onClick={() => copy(state.sessionId)}
          className="font-mono text-zinc-400 hover:text-zinc-100"
          title={`UI id: ${state.sessionId} (click to copy)`}
        >
          ui:{state.sessionId.slice(0, 8)}
        </button>
        {claudeId && (
          <>
            <span className="text-zinc-700">·</span>
            <button
              onClick={() => copy(claudeId)}
              className="font-mono text-zinc-400 hover:text-zinc-100"
              title={`Claude session id: ${claudeId} (click to copy — find transcript at ~/.claude/projects/…/${claudeId}.jsonl)`}
            >
              claude:{claudeId.slice(0, 8)}
            </button>
          </>
        )}
      </div>
    </div>
  ) : (
    <div className="text-xs text-zinc-500">Waiting for session {id.slice(0, 8)}…</div>
  );

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 overflow-auto border-r border-zinc-800 bg-zinc-950/60">
        <div className="px-3 py-2 text-xs uppercase tracking-wide text-zinc-500">Sessions</div>
        <ul>
          {[...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt).map((s) => (
            <li key={s.sessionId}>
              <Link
                href={`/session/${s.sessionId}`}
                className={`block px-3 py-2 text-xs hover:bg-zinc-800 ${s.sessionId === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
              >
                {s.title ? (
                  <div className="truncate font-medium" title={s.cwd}>{s.title}</div>
                ) : (
                  <div className="truncate font-mono" title={s.cwd}>{s.cwd.split('/').pop() || s.cwd}</div>
                )}
                <div className="text-[10px] text-zinc-500">{s.status}</div>
              </Link>
            </li>
          ))}
          {sessions.length === 0 && (
            <li className="px-3 py-2 text-xs text-zinc-600">No sessions</li>
          )}
        </ul>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate('/')}
              className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title="Back to dashboard"
            >
              ← Back
            </button>
            <div className="min-w-0">{headerInfo}</div>
          </div>
          {state && (
            <div className="flex gap-2">
              {(state.status === 'running' || state.status === 'starting' || state.status === 'waiting-permission' || state.currentTool !== null || streaming.length > 0) && (
                <button
                  onClick={() => send({ type: 'client.interrupt', payload: { sessionId: id } })}
                  className="rounded bg-amber-600/80 px-3 py-1 text-sm hover:bg-amber-500"
                  title="Interrupt the current turn (session stays alive)"
                >
                  Stop
                </button>
              )}
              {(state.status === 'idle' || state.status === 'running' || state.status === 'starting' || state.status === 'waiting-permission') && (
                <button
                  onClick={() => {
                    if (confirm('Restart session? This ends the current chat and starts a fresh one in the same directory. Cost/tokens/turns reset to 0.')) {
                      send({ type: 'client.restart', payload: { sessionId: id } });
                    }
                  }}
                  className="rounded bg-zinc-700/70 px-3 py-1 text-sm text-zinc-200 hover:bg-blue-600 hover:text-white"
                  title="Start a fresh chat in the same card (new claudeSessionId, empty context)"
                >
                  Restart
                </button>
              )}
              {(state.status === 'idle' || state.status === 'running' || state.status === 'starting' || state.status === 'waiting-permission') && (
                <button
                  onClick={() => {
                    if (confirm('Pause the Claude subprocess? The conversation is preserved — use Resume later to continue.')) {
                      send({ type: 'client.kill', payload: { sessionId: id } });
                    }
                  }}
                  className="rounded bg-zinc-700/70 px-3 py-1 text-sm text-zinc-200 hover:bg-red-600 hover:text-white"
                  title="Stop the subprocess but keep the conversation (resumable)"
                >
                  Pause
                </button>
              )}
              <button
                onClick={() => {
                  if (confirm(`Delete session ${id.slice(0, 8)}?`)) {
                    send({ type: 'client.delete', payload: { sessionId: id } });
                    navigate('/');
                  }
                }}
                className="rounded bg-zinc-800 px-3 py-1 text-sm text-zinc-200 hover:bg-red-600 hover:text-white"
                title="Remove session from dashboard"
              >
                Delete
              </button>
            </div>
          )}
        </div>
        {detached && (
          <div className="border-b border-purple-500/30 bg-purple-950/20 px-6 py-3 flex items-center justify-between gap-3">
            <div className="text-sm text-purple-100">
              Session is detached — the Claude subprocess is no longer running.
              {state?.claudeSessionId ? (
                <span className="text-purple-300"> Click Resume to reattach and continue the conversation.</span>
              ) : (
                <span className="text-amber-300"> This session never exchanged a message — click Start fresh to spawn a new subprocess in the same worktree, with a blank conversation.</span>
              )}
            </div>
            {state?.claudeSessionId ? (
              <button
                onClick={resume}
                className="rounded bg-purple-600 px-3 py-1 text-sm font-medium hover:bg-purple-500"
              >
                Resume
              </button>
            ) : (
              <button
                onClick={() => send({ type: 'client.restart', payload: { sessionId: id } })}
                className="rounded bg-purple-600 px-3 py-1 text-sm font-medium hover:bg-purple-500"
              >
                Start fresh
              </button>
            )}
          </div>
        )}
        <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4">
          {state ? (
            <div className="space-y-2">
              {events.length === 0 && !streaming ? (
                <div className="text-zinc-500">No events yet — the session is still starting.</div>
              ) : (
                events.map((ev, i) => <EventView key={i} event={ev} />)
              )}
              {streaming && (
                <div className="rounded border border-blue-500/30 bg-blue-950/10 px-3 py-2">
                  <div className="prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed">
                    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{streaming}</Markdown>
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-wide text-blue-400/70">streaming…</div>
                </div>
              )}
              {isBusy(state.status) && !streaming && !state.currentTool && (
                <ThinkingIndicator since={state.lastActivityAt} label={state.status === 'waiting-permission' ? 'waiting for permission' : state.status === 'starting' ? 'starting Claude' : 'Claude is thinking'} />
              )}
            </div>
          ) : (
            <div className="text-zinc-500">Loading session…</div>
          )}
        </div>
        {state && (
          <Composer sessionId={id} disabled={state.status === 'ended' || state.status === 'crashed' || state.status === 'detached'} />
        )}
      </div>
    </div>
  );
}
