import { useEffect, useState } from 'react';
import type { TopicDetailBundle } from '../../server/ws/topic-envelope';
import { send, subscribe } from '../lib/ws';

export function useTopicDetail(topicId: string): TopicDetailBundle | null {
  const [detail, setDetail] = useState<TopicDetailBundle | null>(null);

  useEffect(() => {
    send({ type: 'client.topic.subscribe', payload: { topicId } });
    const unsub = subscribe((m) => {
      if (m.type === 'server.topic.detail' && m.payload.topicId === topicId) {
        setDetail(m.payload);
      }
    });
    return () => {
      unsub();
      send({ type: 'client.topic.unsubscribe', payload: { topicId } });
    };
  }, [topicId]);

  return detail;
}
