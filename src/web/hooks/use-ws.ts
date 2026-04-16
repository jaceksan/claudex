import { useEffect, useRef, useState } from 'react';
import type { ServerEnvelope } from '../../server/ws/envelope';
import { send, subscribe, subscribeConnection, type ConnectionState } from '../lib/ws';
import type { SessionState } from '../../server/session/state';

export { send };

export function useServerEvents(handler: (env: ServerEnvelope) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((env) => ref.current(env)), []);
}

export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');
  useEffect(() => subscribeConnection(setState), []);
  return state;
}

export function useSessionList(): SessionState[] {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map());
  const conn = useConnection();

  // Refresh whenever we (re)connect — guarantees our view is in sync after a server restart.
  useEffect(() => {
    if (conn === 'open') send({ type: 'client.listSessions', payload: {} });
  }, [conn]);

  useServerEvents((env) => {
    switch (env.type) {
      case 'session.list':
        setSessions(new Map(env.payload.sessions.map((s) => [s.sessionId, s])));
        break;
      case 'session.created':
      case 'session.updated':
      case 'session.ended':
        setSessions((prev) => new Map(prev).set(env.payload.state.sessionId, env.payload.state));
        break;
      case 'session.deleted':
        setSessions((prev) => {
          const next = new Map(prev);
          next.delete(env.payload.sessionId);
          return next;
        });
        break;
    }
  });

  return [...sessions.values()];
}
