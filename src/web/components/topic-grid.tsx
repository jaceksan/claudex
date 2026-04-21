import { useState } from 'react';
import type { TopicCard as T } from '../../server/ws/topic-envelope';
import { TopicCard } from './topic-card';

/**
 * Dashboard topic list, grouped by repo. Repositories are ordered by most
 * recent activity across their topics so whichever you're working on sits
 * at the top. Each repo section is collapsible; default-open since usage
 * centred on "two or three repos" most of the time.
 */
export function TopicGrid({ topics, onOpenTopic, onDeleteTopic }: { topics: T[]; onOpenTopic: (id: string) => void; onDeleteTopic: (id: string) => void }) {
  if (topics.length === 0) {
    return <div className="p-8 text-center text-zinc-500">No topics yet. Click <b>+ New topic</b> to get started.</div>;
  }

  // Group by repo and order topics within a repo: running first, then most recent.
  const byRepo = new Map<string, { repoName: string; repoId: string; topics: T[]; latest: number }>();
  for (const t of topics) {
    const entry = byRepo.get(t.repoId) ?? { repoName: t.repoName, repoId: t.repoId, topics: [], latest: 0 };
    entry.topics.push(t);
    if (t.lastEventAt > entry.latest) entry.latest = t.lastEventAt;
    byRepo.set(t.repoId, entry);
  }
  const groups = Array.from(byRepo.values())
    .map((g) => ({
      ...g,
      topics: g.topics.slice().sort((a, b) => {
        const ar = a.taskSummary.running > 0 ? 0 : 1;
        const br = b.taskSummary.running > 0 ? 0 : 1;
        if (ar !== br) return ar - br;
        return b.lastEventAt - a.lastEventAt;
      }),
    }))
    .sort((a, b) => b.latest - a.latest);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => <RepoGroup key={g.repoId} group={g} onOpenTopic={onOpenTopic} onDeleteTopic={onDeleteTopic} />)}
    </div>
  );
}

function RepoGroup({ group, onOpenTopic, onDeleteTopic }: {
  group: { repoName: string; repoId: string; topics: T[] };
  onOpenTopic: (id: string) => void;
  onDeleteTopic: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const runningCount = group.topics.filter((t) => t.taskSummary.running > 0).length;
  return (
    <section>
      <header className="mb-3 flex items-baseline gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-sm font-mono text-zinc-300 hover:text-zinc-100"
          title="Collapse / expand"
        >
          <span className="text-zinc-600">{open ? '▾' : '▸'}</span>
          {group.repoName}
          <span className="text-xs text-zinc-500">({group.topics.length})</span>
          {runningCount > 0 && (
            <span className="rounded-full bg-blue-900/40 px-2 py-0 text-[10px] text-blue-200">{runningCount} running</span>
          )}
        </button>
      </header>
      {open && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {group.topics.map((t) => (
            <TopicCard key={t.id} topic={t} onOpen={() => onOpenTopic(t.id)} onDelete={() => onDeleteTopic(t.id)} />
          ))}
        </div>
      )}
    </section>
  );
}
