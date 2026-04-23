import type { TaskRow, TopicDetailBundle } from '../../server/ws/topic-envelope';

type TopicMeta = TopicDetailBundle['topic'];

function taskTypeLabel(type: string): string {
  switch (type) {
    case 'attempt': return 'Task';
    case 'fix-comments': return 'Fix: comments';
    case 'fix-ci': return 'Fix: CI';
    case 'rebase': return 'Rebase';
    case 'free': return 'Free';
    default: return type;
  }
}

function statusPill(task: TaskRow) {
  if (task.acceptedAt) return <span className="rounded-full px-2 py-0.5 text-xs bg-emerald-900/40 text-emerald-200">accepted</span>;
  if (task.discardedAt) return <span className="rounded-full px-2 py-0.5 text-xs bg-zinc-800 text-zinc-500">discarded</span>;
  if (task.sessionStatus === 'running') return <span className="rounded-full px-2 py-0.5 text-xs bg-blue-900/40 text-blue-200">running</span>;
  if (task.sessionStatus === 'idle') return <span className="rounded-full px-2 py-0.5 text-xs bg-amber-900/40 text-amber-200">idle</span>;
  return <span className="rounded-full px-2 py-0.5 text-xs bg-zinc-800 text-zinc-400">{task.sessionStatus}</span>;
}

function isIdle(task: TaskRow): boolean {
  return !task.acceptedAt && !task.discardedAt &&
    (task.sessionStatus === 'idle' || task.sessionStatus === 'ended');
}

function isBusy(task: TaskRow): boolean {
  return task.sessionStatus === 'running' || task.sessionStatus === 'starting' || task.sessionStatus === 'waiting-permission';
}

export function TaskPanel({
  tasks,
  topic,
  onOpenSession,
  onSave,
  onDiscardChanges,
  onDiscardHard,
  onMerge,
  pendingTaskOps,
}: {
  tasks: TaskRow[];
  topic: TopicMeta;
  onOpenSession: (sessionId: string) => void;
  onSave: (sessionId: string) => void;
  onDiscardChanges: (sessionId: string) => void;
  onDiscardHard: (sessionId: string) => void;
  onMerge: (sessionId: string) => void;
  pendingTaskOps?: Map<string, 'saving' | 'merging' | 'discarding'>;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Tasks</h2>
      {tasks.length === 0 && (
        <div className="text-sm text-zinc-500">No tasks yet.</div>
      )}
      <ol className="flex flex-col gap-2">
        {tasks.map((task) => (
          <li key={task.sessionId} className="rounded border border-zinc-800 bg-zinc-950 p-3">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onOpenSession(task.sessionId)}
                className="text-left text-sm text-zinc-100 hover:text-blue-300 flex-1 truncate"
                title={task.sessionId}
              >
                {task.label ?? taskTypeLabel(task.type)}
              </button>
              {statusPill(task)}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {taskTypeLabel(task.type)}
              {task.childBranch && <span className="ml-2 font-mono">{task.childBranch.split('/').pop()}</span>}
            </div>
            {isBusy(task) && (
              <div className="mt-2 text-xs text-zinc-500">Claude is working — buttons hidden until idle.</div>
            )}
            {isIdle(task) && !task.discardedAt && task.type !== 'delivery' && (() => {
              const op = pendingTaskOps?.get(task.sessionId);
              if (op) {
                const label = op === 'saving' ? 'Saving — writing commit message…' : op === 'merging' ? 'Merging to topic — running git…' : 'Discarding…';
                return (
                  <div className="mt-2 flex items-center gap-2 text-xs text-blue-200">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                    {label}
                  </div>
                );
              }
              return (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onSave(task.sessionId)}
                    className="rounded bg-blue-700 px-2 py-0.5 text-xs text-white hover:bg-blue-600"
                    title="Commit uncommitted changes in the worktree"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => onMerge(task.sessionId)}
                    className="rounded bg-emerald-700 px-2 py-0.5 text-xs text-white hover:bg-emerald-600"
                    title="Merge task commits into the topic branch"
                  >
                    {task.type === 'attempt' ? 'Merge to topic' : task.type === 'rebase' ? 'Accept rebase' : 'Apply fix'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm('Drop all uncommitted changes in this task worktree? Commits are kept.')) onDiscardChanges(task.sessionId);
                    }}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-amber-600 hover:text-amber-400"
                  >
                    Discard changes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm('Discard this task? This kills the session, removes the worktree and deletes the branch. Any uncommitted work or local commits are lost.')) onDiscardHard(task.sessionId);
                    }}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-red-600 hover:text-red-400"
                  >
                    Discard task
                  </button>
                </div>
              );
            })()}
          </li>
        ))}
      </ol>
      {topic.phase !== 'Merged' && topic.phase !== 'Closed' && (
        <div className="mt-3 text-xs text-zinc-600">
          {topic.phase === 'Draft' && !topic.acceptedAttemptId
            ? '+ New task from the Action bar below'
            : '+ New fix task from the Action bar below'}
        </div>
      )}
    </div>
  );
}
