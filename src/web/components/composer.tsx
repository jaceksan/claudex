import { useState, type KeyboardEvent } from 'react';
import { send } from '../lib/ws';

export function Composer({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const [text, setText] = useState('');

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    send({ type: 'client.sendInput', payload: { sessionId, text: t } });
    setText('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="border-t border-zinc-800 p-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={3}
        placeholder={disabled ? 'Session not active' : 'Follow-up message · ⌘/Ctrl+Enter to send'}
        className="w-full rounded bg-zinc-900 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500 disabled:opacity-50"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
