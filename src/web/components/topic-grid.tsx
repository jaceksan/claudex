import { useState } from 'react';
import type { TopicCard as T } from '../../server/ws/topic-envelope';
import { TopicCard } from './topic-card';

const ARCHIVED_PHASES = new Set(['Merged', 'Closed']);

/**
 * Dashboard topic list, grouped by repo. Repositories are ordered by most
 * recent activity across their topics so whichever you're working on sits
 * at the top. Each repo section is collapsible; default-open since usage
 * centred on "two or three repos" most of the time. Merged/Closed topics
 * move into a collapsed "Archived" subsection inside their repo group so
 * they stay reachable for review + explicit delete without dominating the
 * live topic list.
 */
export function TopicGrid({ topics, onOpenTopic, onDeleteTopic }: { topics: T[]; onOpenTopic: (id: string) => void; onDeleteTopic: (id: string) => void }) {
  if (topics.length === 0) {
    return <div className="p-8 text-center text-zinc-500">No topics yet. Click <b>+ New topic</b> to get started.</div>;
  }

  // Group by repo and order topics within a repo: running first, then most recent.
  const byRepo = new Map<string, { repoName: string; repoId: string; active: T[]; archived: T[]; latest: number }>();
  for (const t of topics) {
    const entry = byRepo.get(t.repoId) ?? { repoName: t.repoName, repoId: t.repoId, active: [], archived: [], latest: 0 };
    (ARCHIVED_PHASES.has(t.phase) ? entry.archived : entry.active).push(t);
    // Archived topics don't drive repo ordering — otherwise a long-archived
    // repo could outrank a repo with fresh work.
    if (!ARCHIVED_PHASES.has(t.phase) && t.lastEventAt > entry.latest) entry.latest = t.lastEventAt;
    byRepo.set(t.repoId, entry);
  }
  const byActivity = (a: T, b: T) => {
    const ar = a.taskSummary.running > 0 ? 0 : 1;
    const br = b.taskSummary.running > 0 ? 0 : 1;
    if (ar !== br) return ar - br;
    return b.lastEventAt - a.lastEventAt;
  };
  const groups = Array.from(byRepo.values())
    .map((g) => ({
      ...g,
      active: g.active.slice().sort(byActivity),
      archived: g.archived.slice().sort((a, b) => b.lastEventAt - a.lastEventAt),
    }))
    .sort((a, b) => b.latest - a.latest);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => <RepoGroup key={g.repoId} group={g} onOpenTopic={onOpenTopic} onDeleteTopic={onDeleteTopic} />)}
    </div>
  );
}

function RepoGroup({ group, onOpenTopic, onDeleteTopic }: {
  group: { repoName: string; repoId: string; active: T[]; archived: T[] };
  onOpenTopic: (id: string) => void;
  onDeleteTopic: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const runningCount = group.active.filter((t) => t.taskSummary.running > 0).length;
  const totalCount = group.active.length + group.archived.length;
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
          <span className="text-xs text-zinc-500">({totalCount})</span>
          {runningCount > 0 && (
            <span className="rounded-full bg-blue-900/40 px-2 py-0 text-[10px] text-blue-200">{runningCount} running</span>
          )}
        </button>
      </header>
      {open && (
        <>
          {group.active.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {group.active.map((t) => (
                <TopicCard key={t.id} topic={t} onOpen={() => onOpenTopic(t.id)} onDelete={() => onDeleteTopic(t.id)} />
              ))}
            </div>
          )}
          {group.active.length === 0 && group.archived.length > 0 && (
            <div className="mb-2 text-xs text-zinc-500">No active topics — only archived.</div>
          )}
          {group.archived.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setArchivedOpen((v) => !v)}
                className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300"
                title="Merged and closed topics — reach here to delete them"
              >
                <span>{archivedOpen ? '▾' : '▸'}</span>
                Archived
                <span className="text-zinc-600">({group.archived.length})</span>
              </button>
              {archivedOpen && (
                <div className="mt-2 grid grid-cols-1 gap-4 opacity-70 md:grid-cols-2 lg:grid-cols-3">
                  {group.archived.map((t) => (
                    <TopicCard key={t.id} topic={t} onOpen={() => onOpenTopic(t.id)} onDelete={() => onDeleteTopic(t.id)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
