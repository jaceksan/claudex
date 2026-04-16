import { useEffect, useState } from 'react';
import { send, subscribe } from '../lib/ws';
import type { ServerEnvelope } from '../../server/ws/envelope';
import type { SessionState } from '../../server/session/state';
import type { StreamEvent } from '../../server/stream-json/types';
import { EventView } from '../components/event-view';
import { BashPane } from '../components/bash-pane';

export default function SessionPage({ id }: { id: string }) {
  const [state, setState] = useState<SessionState | null>(null);
  const [events, setEvents] = useState<StreamEvent[]>([]);

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

  if (!state) {
    return <div className="p-6 text-zinc-500">Loading session {id}…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-sm text-zinc-300">{state.cwd}</div>
            <div className="text-xs text-zinc-500">
              {state.status} · ${state.costUsd.toFixed(4)} · {state.tokens.input}/{state.tokens.output} tokens · {state.completedTools} tools
            </div>
          </div>
          <button
            onClick={() => send({ type: 'client.kill', payload: { sessionId: id } })}
            className="rounded bg-red-600/80 px-3 py-1 text-sm hover:bg-red-500"
          >
            Kill
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <div className="space-y-4">
          {events.map((ev, i) => <EventView key={i} event={ev} />)}
        </div>
      </div>
      <BashPane events={events} />
    </div>
  );
}
