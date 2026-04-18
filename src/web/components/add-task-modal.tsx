import { useEffect, useState } from 'react';
import { send, subscribe, getConnectionState } from '../lib/ws';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;

export function AddTaskModal({ topicId, onClose }: { topicId: string; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [effort, setEffort] = useState<typeof EFFORTS[number]>('medium');
  const [mode, setMode] = useState<typeof MODES[number]>('acceptEdits');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!submitting) return;
    return subscribe((m) => {
      if (m.type === 'server.topic.error' && m.payload.ctx === 'addAttempt') {
        setError(m.payload.message);
        setSubmitting(false);
      } else if (m.type === 'server.topic.detail' && m.payload.topicId === topicId) {
        // New task landed on the topic detail — our submit succeeded.
        onClose();
      }
    });
  }, [submitting, topicId, onClose]);

  function submit() {
    if (submitting) return;
    if (!title.trim()) {
      setError('Title is required — it becomes the task branch / worktree name.');
      return;
    }
    if (getConnectionState() !== 'open') {
      setError('Not connected to the claudex server. Start it and try again.');
      return;
    }
    setError(null);
    setSubmitting(true);
    send({
      type: 'client.topic.addAttempt',
      payload: {
        topicId,
        effort,
        permissionMode: mode,
        label: title.trim(),
      },
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">New task</h2>

        <label className="mb-3 block text-sm">
          <span className="text-zinc-300">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            required
            placeholder="e.g. Fix the null-check path"
            className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
          />
          <div className="mt-1 text-xs text-zinc-500">Becomes the task branch + worktree name. Must be unique within this topic.</div>
        </label>

        <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
          <label className="block">
            <span className="text-zinc-300">Effort</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value as typeof EFFORTS[number])} className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 outline-none ring-1 ring-zinc-700 focus:ring-blue-500">
              {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-zinc-300">Permission</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof MODES[number])} className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 outline-none ring-1 ring-zinc-700 focus:ring-blue-500">
              {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        </div>

        <p className="mb-3 text-xs text-zinc-500">Type the first message to the session from inside the task once it opens.</p>

        {error && <div className="mb-3 rounded bg-red-900/40 p-2 text-xs text-red-200">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button>
          <button onClick={submit} disabled={submitting} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">{submitting ? 'Starting…' : 'Start task'}</button>
        </div>
      </div>
    </div>
  );
}
