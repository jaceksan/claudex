import { useState } from 'react';
import { send } from '../lib/ws';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;

export function AddAttemptModal({ topicId, onClose }: { topicId: string; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [effort, setEffort] = useState<typeof EFFORTS[number]>('medium');
  const [mode, setMode] = useState<typeof MODES[number]>('acceptEdits');
  const [submitting, setSubmitting] = useState(false);

  function submit() {
    if (submitting) return;
    setSubmitting(true);
    send({
      type: 'client.topic.addAttempt',
      payload: {
        topicId,
        prompt: prompt.trim() || undefined,
        effort,
        permissionMode: mode,
      },
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">New attempt</h2>

        <label className="mb-3 block text-sm">
          <span className="text-zinc-300">Initial prompt (optional)</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} autoFocus placeholder="What should the session do first?" className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500" />
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

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button>
          <button onClick={submit} disabled={submitting} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">Start attempt</button>
        </div>
      </div>
    </div>
  );
}
