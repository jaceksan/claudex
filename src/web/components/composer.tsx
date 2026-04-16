import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { send } from '../lib/ws';
import type { CommandEntry } from '../../server/commands';

let catalogPromise: Promise<CommandEntry[]> | null = null;
function loadCatalog(): Promise<CommandEntry[]> {
  if (!catalogPromise) {
    catalogPromise = fetch('/api/commands')
      .then((r) => r.json())
      .then((j: { entries: CommandEntry[] }) => j.entries)
      .catch(() => []);
  }
  return catalogPromise;
}

interface Match { entry: CommandEntry; score: number }

function rank(entries: CommandEntry[], query: string): Match[] {
  const q = query.toLowerCase();
  const out: Match[] = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    const desc = e.description.toLowerCase();
    let score: number;
    if (q === '') score = 0;
    else if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (desc.includes(q)) score = 2;
    else continue;
    // Source bias: builtin before user before plugin within the same score tier.
    const sourceBias = e.source === 'builtin' ? 0 : e.source === 'user' ? 0.1 : 0.2;
    out.push({ entry: e, score: score + sourceBias });
  }
  out.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  return out;
}

function findSlashToken(text: string, cursor: number): { start: number; query: string } | null {
  // Trigger when "/" appears at start-of-text or after a newline, up to the cursor,
  // with no whitespace between the slash and the cursor.
  const before = text.slice(0, cursor);
  const m = before.match(/(?:^|\n)\/([^\s/]*)$/);
  if (!m) return null;
  const start = before.length - m[0].length + (m[0].startsWith('\n') ? 1 : 0);
  return { start, query: m[1] };
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-blue-500/30 text-blue-200">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

export function Composer({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [catalog, setCatalog] = useState<CommandEntry[]>([]);
  const [active, setActive] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => { loadCatalog().then(setCatalog); }, []);

  const token = useMemo(() => findSlashToken(text, cursor), [text, cursor]);
  const matches = useMemo(() => (token ? rank(catalog, token.query) : []), [catalog, token]);
  const open = !!token && matches.length > 0;

  useEffect(() => { setActive(0); }, [token?.query]);
  useEffect(() => {
    if (!open) return;
    itemRefs.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    send({ type: 'client.sendInput', payload: { sessionId, text: t } });
    setText('');
    setCursor(0);
  }

  function applyCompletion(entry: CommandEntry) {
    if (!token) return;
    const before = text.slice(0, token.start);
    const after = text.slice(cursor);
    const insertion = `/${entry.name} `;
    const next = before + insertion + after;
    const nextCursor = (before + insertion).length;
    setText(next);
    setCursor(nextCursor);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyCompletion(matches[active].entry);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setText(text); setCursor(cursor); /* close via dropping token */ taRef.current?.blur(); taRef.current?.focus(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  function syncCursor() {
    const ta = taRef.current;
    if (ta) setCursor(ta.selectionStart);
  }

  return (
    <div className="border-t border-zinc-800 p-4">
      <div className="relative">
        {open && (
          <div
            ref={listRef}
            className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
            role="listbox"
          >
            <div className="sticky top-0 border-b border-zinc-800 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-500 backdrop-blur">
              {matches.length} match{matches.length === 1 ? '' : 'es'} — ↑↓ navigate · ↵/Tab insert · Esc cancel
            </div>
            {matches.map((m, i) => {
              const e = m.entry;
              const isActive = i === active;
              return (
                <button
                  key={`${e.source}:${e.name}`}
                  ref={(el) => { itemRefs.current[i] = el; }}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(ev) => { ev.preventDefault(); applyCompletion(e); }}
                  className={`block w-full px-3 py-2 text-left text-sm ${isActive ? 'bg-blue-600/20' : 'hover:bg-zinc-800'}`}
                  role="option"
                  aria-selected={isActive}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-zinc-100">/{highlight(e.name, token?.query ?? '')}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      e.source === 'builtin' ? 'bg-zinc-700 text-zinc-300'
                      : e.source === 'user' ? 'bg-emerald-700/40 text-emerald-200'
                      : 'bg-purple-700/40 text-purple-200'
                    }`}>
                      {e.kind}{e.source === 'plugin' ? ` · ${e.plugin}` : ''}
                    </span>
                  </div>
                  {e.description && (
                    <div className="mt-0.5 truncate text-xs text-zinc-400" title={e.description}>
                      {highlight(e.description, token?.query ?? '')}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setCursor(e.target.selectionStart); }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCursor}
          onClick={syncCursor}
          onSelect={syncCursor}
          disabled={disabled}
          rows={3}
          placeholder={disabled ? 'Session not active' : 'Follow-up message · ⌘/Ctrl+Enter to send · / for commands'}
          className="w-full rounded bg-zinc-900 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500 disabled:opacity-50"
        />
      </div>
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
