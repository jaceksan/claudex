import { useState } from 'react';
import { useLocation } from 'wouter';
import { useTopics } from '../hooks/use-topics';
import { TopicGrid } from '../components/topic-grid';
import { NewTopicModal } from '../components/new-topic-modal';
import { send } from '../lib/ws';

export default function DashboardPage() {
  const topics = useTopics();
  const [showNew, setShowNew] = useState(false);
  const [, navigate] = useLocation();

  function handleDelete(topicId: string) {
    const topic = topics.find((t) => t.id === topicId);
    const label = topic ? `"${topic.title}"` : 'this topic';
    if (!confirm(`Delete ${label} and all its attempts? This kills running sessions, removes worktrees, and drops the topic branch.`)) return;
    send({ type: 'client.topic.delete', payload: { topicId } });
  }

  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Topics</h1>
        <button onClick={() => setShowNew(true)} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500">
          + New topic
        </button>
      </div>
      <TopicGrid topics={topics} onOpenTopic={(id) => navigate(`/topic/${id}`)} onDeleteTopic={handleDelete} />
      {showNew && <NewTopicModal onClose={() => setShowNew(false)} />}
    </div>
  );
}
