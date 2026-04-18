import type { TopicCard as T } from '../../server/ws/topic-envelope';
import { TopicCard } from './topic-card';

export function TopicGrid({ topics, onOpenTopic, onDeleteTopic }: { topics: T[]; onOpenTopic: (id: string) => void; onDeleteTopic: (id: string) => void }) {
  const sorted = [...topics].sort((a, b) => {
    // Running first, then most recently active
    const aRunning = a.taskSummary.running > 0;
    const bRunning = b.taskSummary.running > 0;
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return b.lastEventAt - a.lastEventAt;
  });

  if (sorted.length === 0) {
    return <div className="p-8 text-center text-zinc-500">No topics yet. Click <b>+ New topic</b> to get started.</div>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {sorted.map((t) => (
        <TopicCard key={t.id} topic={t} onOpen={() => onOpenTopic(t.id)} onDelete={() => onDeleteTopic(t.id)} />
      ))}
    </div>
  );
}
