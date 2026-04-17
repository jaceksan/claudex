import { useEffect, useState } from 'react';
import type { TopicCard } from '../../server/ws/topic-envelope';
import { send, subscribe } from '../lib/ws';

export function useTopics(): TopicCard[] {
  const [topics, setTopics] = useState<TopicCard[]>([]);
  useEffect(() => {
    send({ type: 'client.topic.list', payload: {} });
    const unsub = subscribe((m) => {
      if (m.type === 'server.topic.state') setTopics(m.payload.topics);
    });
    return unsub;
  }, []);
  return topics;
}
