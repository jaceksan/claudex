import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { send, subscribe } from '../lib/ws';
import { useSessionList } from '../hooks/use-ws';
import type { ServerEnvelope } from '../../server/ws/envelope';
import type { SessionState } from '../../server/session/state';
import type { StreamEvent } from '../../server/stream-json/types';
import { EventView } from '../components/event-view';
import { BashPane } from '../components/bash-pane';
import { Composer } from '../components/composer';

export default function SessionPage({ id }: { id: string }) {
  const [state, setState] = useState<SessionState | null>(null);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const sessions = useSessionList();
  const [, navigate] = useLocation();

  useEffect(() => {
    send({ type: 'client.subscribe', payload: { sessionId: id } });
    const off = subscribe((env: ServerEnvelope) => {
      if (env.type === 'session.replay' && env.payload.state.sessionId === id) {
        setState(env.payload.state);
        setEvents(env.payload.events);
      } else if (env.type === 'session.event' && env.payload.sessionId === id) {
        setEvents((prev) => [...prev, env.payload.event]);
      } else if (
        (env.type === 'session.updated' || env.type === 'session.ended' || env.type === 'session.created')
        && env.payload.state.sessionId === id
      ) {
        setState(env.payload.state);
      }
    });
    return () => {
      send({ type: 'client.unsubscribe', payload: { sessionId: id } });
      off();
    };
  }, [id]);

  const headerInfo = state ? (
    <>
      <div className="font-mono text-sm text-zinc-300 truncate max-w-md" title={state.cwd}>{state.cwd}</div>
      <div className="text-xs text-zinc-500">
        {state.status} · ${state.costUsd.toFixed(4)} · {state.tokens.input}/{state.tokens.output} tokens · {state.completedTools} tools
      </div>
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
            <button
              onClick={() => send({ type: 'client.kill', payload: { sessionId: id } })}
              className="rounded bg-red-600/80 px-3 py-1 text-sm hover:bg-red-500"
            >
              Kill
            </button>
          )}
        </div>
        <div className="flex-1 overflow-auto p-6">
          {state ? (
            <div className="space-y-4">
              {events.length === 0 ? (
                <div className="text-zinc-500">No events yet — the session is still starting.</div>
              ) : (
                events.map((ev, i) => <EventView key={i} event={ev} />)
              )}
            </div>
          ) : (
            <div className="text-zinc-500">Loading session…</div>
          )}
        </div>
        {state && (
          <>
            <Composer sessionId={id} disabled={state.status === 'ended' || state.status === 'crashed'} />
            <BashPane events={events} />
          </>
        )}
      </div>
    </div>
  );
}
