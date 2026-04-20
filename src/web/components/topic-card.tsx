import type { TopicCard as T } from '../../server/ws/topic-envelope';

export function TopicCard({ topic, onOpen, onDelete }: { topic: T; onOpen: () => void; onDelete: () => void }) {
  const summary = `${topic.taskSummary.running} running · ${topic.taskSummary.accepted} done · ${topic.taskSummary.discarded} archived`;
  return (
    <div className="relative flex flex-col rounded-lg border border-zinc-800 bg-zinc-900 p-4 hover:border-zinc-700">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete topic"
        className="absolute right-2 top-2 rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
      >
        ×
      </button>
      <button onClick={onOpen} className="flex flex-col text-left">
        <div className="flex items-center justify-between pr-6">
          <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
            <span className="truncate font-mono text-zinc-400" title={`Repository: ${topic.repoName}`}>
              {topic.repoName}
            </span>
            {topic.ticketKey && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="font-mono">{topic.ticketKey}</span>
              </>
            )}
          </div>
          <span className={`rounded-full px-2 py-0.5 text-xs ${stagePillClass(topic.phase)}`}>{topic.phase}</span>
        </div>
        <div className="mt-1 text-sm font-medium text-zinc-100">{topic.title}</div>
        <div className="mt-2 text-xs text-zinc-500">{summary}</div>
        {topic.prNumber && <div className="mt-1 text-xs text-blue-300">PR #{topic.prNumber}</div>}
      </button>
    </div>
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
