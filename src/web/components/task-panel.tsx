import type { TaskRow, TopicDetailBundle } from '../../server/ws/topic-envelope';

type TopicMeta = TopicDetailBundle['topic'];

function taskTypeLabel(type: string): string {
  switch (type) {
    case 'attempt': return 'Attempt';
    case 'fix-comments': return 'Fix comments';
    case 'fix-ci': return 'Fix CI';
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

export function TaskPanel({
  tasks,
  topic,
  onOpenSession,
  onAccept,
  onDiscard,
}: {
  tasks: TaskRow[];
  topic: TopicMeta;
  onOpenSession: (sessionId: string) => void;
  onAccept: (sessionId: string) => void;
  onDiscard: (sessionId: string) => void;
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
            {isIdle(task) && !task.discardedAt && (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => onAccept(task.sessionId)}
                  className="rounded bg-emerald-700 px-2 py-0.5 text-xs text-white hover:bg-emerald-600"
                >
                  {task.type === 'attempt' ? 'Accept' : 'Accept fix'}
                </button>
                <button
                  type="button"
                  onClick={() => onDiscard(task.sessionId)}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-red-600 hover:text-red-400"
                >
                  Discard
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {topic.phase !== 'Merged' && topic.phase !== 'Closed' && (
        <div className="mt-3 text-xs text-zinc-600">
          {topic.phase === 'Draft' && !topic.acceptedAttemptId
            ? '+ New attempt from the Action bar below'
            : '+ New fix task from the Action bar below'}
        </div>
      )}
    </div>
  );
}
