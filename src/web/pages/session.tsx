import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { send, subscribe } from '../lib/ws';
import { useConnection, useSessionList } from '../hooks/use-ws';
import type { ServerEnvelope } from '../../server/ws/envelope';
import type { SessionState } from '../../server/session/state';
import type { StreamEvent } from '../../server/stream-json/types';
import { EventView } from '../components/event-view';
import { Composer } from '../components/composer';
import { GitBadge } from '../components/git-badge';
import { useGitInfo } from '../hooks/use-git-info';
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
  const sessions = useSessionList();
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

  const git = useGitInfo(state?.sessionId, 10_000);
  const copy = (text: string) => { navigator.clipboard?.writeText(text).catch(() => {}); };
  const claudeId = state?.claudeSessionId;
  const rename = () => {
    if (!state) return;
    const next = window.prompt('Session title (leave empty to clear):', state.title ?? '');
    if (next === null) return; // cancelled
    send({ type: 'client.rename', payload: { sessionId: id, title: next.trim() || null } });
  };

  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!detailsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (detailsRef.current && !detailsRef.current.contains(e.target as Node)) setDetailsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetailsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [detailsOpen]);

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
        <div className="border-b border-zinc-800 px-6 py-2">
          {state ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    onClick={() => navigate('/')}
                    className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                    title="Back to dashboard"
                  >
                    ← Back
                  </button>
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${statusColors[state.status]}`}>
                    {isBusy(state.status) && (
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                    )}
                    {state.status}
                  </span>
                  {state.title ? (
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
                <div className="flex items-center gap-2">
                  <div className="relative" ref={detailsRef}>
                    <button
                      onClick={() => setDetailsOpen((v) => !v)}
                      className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                      title="Session details (effort, ids)"
                      aria-expanded={detailsOpen}
                    >
                      ⋯
                    </button>
                    {detailsOpen && (
                      <div className="absolute right-0 z-10 mt-1 w-72 rounded border border-zinc-700 bg-zinc-900 p-3 shadow-xl">
                        <div className="space-y-2 text-xs text-zinc-400">
                          <label className="flex items-center justify-between gap-2" title="Claude effort level — changing this sends /effort to the running session">
                            <span>effort</span>
                            <select
                              value={state.effort ?? 'medium'}
                              onChange={(e) => send({ type: 'client.setEffort', payload: { sessionId: id, effort: e.target.value as EffortLevel } })}
                              disabled={state.status === 'ended' || state.status === 'crashed'}
                              className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-blue-500 disabled:opacity-50"
                            >
                              {EFFORTS.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
                            </select>
                          </label>
                          <div className="flex items-center justify-between gap-2">
                            <span>ui id</span>
                            <button
                              onClick={() => copy(state.sessionId)}
                              className="font-mono text-zinc-300 hover:text-zinc-100"
                              title={`${state.sessionId} (click to copy)`}
                            >
                              {state.sessionId.slice(0, 8)}…
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span>claude id</span>
                            {claudeId ? (
                              <button
                                onClick={() => copy(claudeId)}
                                className="font-mono text-zinc-300 hover:text-zinc-100"
                                title={`${claudeId} (click to copy — find transcript at ~/.claude/projects/…/${claudeId}.jsonl)`}
                              >
                                {claudeId.slice(0, 8)}…
                              </button>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
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
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                <span className="font-mono truncate max-w-md text-zinc-400" title={state.cwd}>{state.cwd}</span>
                {state.worktreeBranch && (
                  <span
                    className="rounded bg-emerald-900/40 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300 ring-1 ring-inset ring-emerald-700/60"
                    title={`worktree off ${state.worktreeOrigin}`}
                  >
                    🌿 {state.worktreeBranch}
                  </span>
                )}
                <span className="text-zinc-700">·</span>
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
                {git?.isRepo && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <GitBadge info={git} compact />
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-zinc-500">Waiting for session {id.slice(0, 8)}…</div>
          )}
        </div>
        {detached && (
          <div className="border-b border-purple-500/30 bg-purple-950/20 px-6 py-3 flex items-center justify-between gap-3">
            <div className="text-sm text-purple-100">
              Session is detached — the Claude subprocess is no longer running.
              {state?.claudeSessionId ? (
                <span className="text-purple-300"> Click Resume to reattach and continue the conversation.</span>
              ) : (
                <span className="text-amber-300"> This session has no recorded Claude id (likely predates the migration); it can't be resumed — please Delete it.</span>
              )}
            </div>
            {state?.claudeSessionId && (
              <button
                onClick={resume}
                className="rounded bg-purple-600 px-3 py-1 text-sm font-medium hover:bg-purple-500"
              >
                Resume
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
