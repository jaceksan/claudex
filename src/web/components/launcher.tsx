import { useState, useEffect } from 'react';
import { send } from '../lib/ws';

const RECENT_KEY = 'claudex.recentCwds';
const MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; }
}
function saveRecent(cwd: string): void {
  const prev = loadRecent().filter((x) => x !== cwd);
  const next = [cwd, ...prev].slice(0, 10);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export function LauncherModal({ onClose }: { onClose: () => void }) {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<typeof MODES[number]>('default');
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => { setRecent(loadRecent()); }, []);

  function submit() {
    if (!cwd.trim()) return;
    saveRecent(cwd.trim());
    send({
      type: 'client.launch',
      payload: {
        cwd: cwd.trim(),
        prompt: prompt.trim() || undefined,
        permissionMode: mode === 'default' ? undefined : mode,
      },
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">New session</h2>

        <label className="block text-sm">
          <span className="text-zinc-300">Working directory</span>
          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            list="recent-cwds"
            autoFocus
            placeholder="/home/you/project"
            className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 font-mono text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
          />
          <datalist id="recent-cwds">
            {recent.map((r) => <option key={r} value={r} />)}
          </datalist>
        </label>

        <label className="mt-4 block text-sm">
          <span className="text-zinc-300">Initial prompt (optional)</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="What should the session do first?"
            className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
          />
        </label>

        <label className="mt-4 block text-sm">
          <span className="text-zinc-300">Permission mode</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof MODES[number])}
            className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
          >
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!cwd.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500 disabled:opacity-40"
          >
            Launch
          </button>
        </div>
      </div>
    </div>
  );
}
