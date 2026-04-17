import type { TopicCard as T } from '../../server/ws/topic-envelope';

export function TopicCard({ topic, onOpen }: { topic: T; onOpen: () => void }) {
  const summary = `${topic.taskSummary.running} running · ${topic.taskSummary.accepted} done · ${topic.taskSummary.discarded} archived`;
  return (
    <button onClick={onOpen} className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-left hover:border-zinc-700">
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">{topic.ticketKey ?? 'free-form'}</div>
        <span className={`rounded-full px-2 py-0.5 text-xs ${stagePillClass(topic.phase)}`}>{topic.phase}</span>
      </div>
      <div className="mt-1 text-sm font-medium text-zinc-100">{topic.title}</div>
      <div className="mt-2 text-xs text-zinc-500">{summary}</div>
      {topic.prNumber && <div className="mt-1 text-xs text-blue-300">PR #{topic.prNumber}</div>}
    </button>
  );
}

function stagePillClass(phase: string): string {
  switch (phase) {
    case 'Exploring': return 'bg-violet-900/40 text-violet-200';
    case 'Draft': return 'bg-zinc-800 text-zinc-200';
    case 'Open': return 'bg-emerald-900/40 text-emerald-200';
    case 'Merged': return 'bg-sky-900/40 text-sky-200';
    case 'Closed': return 'bg-zinc-800 text-zinc-500';
    default: return 'bg-zinc-800';
  }
}
