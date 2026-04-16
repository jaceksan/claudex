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
  const headerInfo = state ? (
    <>
      <div className="font-mono text-sm text-zinc-300 truncate max-w-md" title={state.cwd}>{state.cwd}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
        <span>{state.status}</span>
        <span>·</span>
        <span>${state.costUsd.toFixed(4)}</span>
        <span>·</span>
        <span>{state.tokens.input}/{state.tokens.output} tokens</span>
        <span>·</span>
        <span>{state.completedTools} tools</span>
        <span>·</span>
        <button
          onClick={() => copy(state.sessionId)}
          className="font-mono text-zinc-400 hover:text-zinc-100"
          title={`UI id: ${state.sessionId} (click to copy)`}
        >
          ui:{state.sessionId.slice(0, 8)}
        </button>
        {claudeId && (
          <>
            <span>·</span>
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
      {git?.isRepo && <div className="mt-1"><GitBadge info={git} /></div>}
    </>
  ) : (
    <div className="text-xs text-zinc-500">Waiting for session {id.slice(0, 8)}…</div>
  );

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 overflow-auto border-r border-zinc-800 bg-zinc-950/60">
        <div className="px-3 py-2 text-xs uppercase tracking-wide text-zinc-500">Sessions</div>
        <ul>
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <Link
                href={`/session/${s.sessionId}`}
                className={`block px-3 py-2 text-xs hover:bg-zinc-800 ${s.sessionId === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
              >
                <div className="truncate font-mono" title={s.cwd}>{s.cwd}</div>
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
                    if (confirm('Kill the Claude subprocess? The session will end; use Delete to remove it.')) {
                      send({ type: 'client.kill', payload: { sessionId: id } });
                    }
                  }}
                  className="rounded bg-zinc-700/70 px-3 py-1 text-sm text-zinc-200 hover:bg-red-600 hover:text-white"
                  title="End the Claude subprocess"
                >
                  Kill
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
              Session is detached — the Claude subprocess is no longer running (server restart or previous kill).
              <span className="text-purple-300"> Click Resume to reattach and continue the conversation.</span>
            </div>
            <button
              onClick={resume}
              className="rounded bg-purple-600 px-3 py-1 text-sm font-medium hover:bg-purple-500"
            >
              Resume
            </button>
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
