import { useState } from 'react';
import { send } from '../lib/ws';
import type { SessionState } from '../../server/session/state';

export function BroadcastModal({
  sessions,
  onClose,
}: {
  sessions: SessionState[];
  onClose: () => void;
}) {
  const [text, setText] = useState('');

  function submit() {
    const t = text.trim();
    if (!t) return;
    for (const s of sessions) {
      send({ type: 'client.sendInput', payload: { sessionId: s.sessionId, text: t } });
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-semibold">
          Broadcast to {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </h2>
        <div className="mb-4 max-h-32 overflow-y-auto text-xs text-zinc-400">
          {sessions.map((s) => (
            <div key={s.sessionId} className="truncate" title={s.cwd}>
              · {s.title || s.cwd}
            </div>
          ))}
        </div>

        <label className="block text-sm">
          <span className="text-zinc-300">Prompt</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            rows={5}
            placeholder="Same prompt sent to every selected session"
            className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
          />
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
            disabled={!text.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500 disabled:opacity-40"
          >
            Broadcast
          </button>
        </div>
      </div>
    </div>
  );
}
