import { useTopics } from '../hooks/use-topics';
import { TopicGrid } from '../components/topic-grid';

export default function DashboardPage() {
  const topics = useTopics();
  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Topics</h1>
        {/* + New topic button — wired in Task 7 */}
        <button className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white opacity-60" disabled>
          + New topic
        </button>
      </div>
      <TopicGrid topics={topics} onOpenTopic={() => { /* Plan 3: topic detail page */ }} />
    </div>
  );
}
