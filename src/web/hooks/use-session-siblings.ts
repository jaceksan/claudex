import { useEffect, useState } from 'react';
import type { SiblingRow } from '../../server/ws/topic-envelope';
import { send, subscribe } from '../lib/ws';

export function useSessionSiblings(sessionId: string): { topicId: string | null; siblings: SiblingRow[] } | null {
  const [data, setData] = useState<{ topicId: string | null; siblings: SiblingRow[] } | null>(null);

  useEffect(() => {
    send({ type: 'client.session.siblings', payload: { sessionId } });
    const unsub = subscribe((m) => {
      if (m.type === 'server.session.siblings' && m.payload.sessionId === sessionId) {
        setData({ topicId: m.payload.topicId, siblings: m.payload.siblings });
      }
    });
    return () => unsub();
  }, [sessionId]);

  return data;
}
