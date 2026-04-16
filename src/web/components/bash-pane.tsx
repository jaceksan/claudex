import { useEffect, useRef, useState, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { StreamEvent, ToolUseBlock, ToolResultBlock } from '../../server/stream-json/types';

interface BashEntry {
  id: string;
  command: string;
  result: string | null;
  isError: boolean;
}

function extractBashEntries(events: StreamEvent[]): BashEntry[] {
  const uses = new Map<string, ToolUseBlock>();
  const results = new Map<string, ToolResultBlock>();
  for (const ev of events) {
    if (ev.type === 'assistant') {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use' && block.name === 'Bash') uses.set(block.id, block);
      }
    } else if (ev.type === 'user') {
      const content = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const block of content) {
        if (typeof block === 'object' && block.type === 'tool_result') {
          results.set(block.tool_use_id, block);
        }
      }
    }
  }
  const entries: BashEntry[] = [];
  for (const [id, use] of uses) {
    const r = results.get(id);
    entries.push({
      id,
      command: String(use.input.command ?? ''),
      result: r ? (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)) : null,
      isError: r?.is_error ?? false,
    });
  }
  return entries.slice(-3); // last 3 (LRU)
}

function TerminalView({ entry }: { entry: BashEntry }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0a0a0a', foreground: '#e4e4e7' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;

    term.writeln(`\x1b[2m$ ${entry.command}\x1b[0m`);
    if (entry.result === null) {
      term.writeln('\x1b[33m[running…]\x1b[0m');
    } else if (entry.isError) {
      term.writeln(`\x1b[31m${entry.result}\x1b[0m`);
    } else {
      term.writeln(entry.result);
    }

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      term.dispose();
    };
  }, [entry.id, entry.command, entry.result, entry.isError]);

  return <div ref={hostRef} className="h-full w-full" />;
}

export function BashPane({ events }: { events: StreamEvent[] }) {
  const entries = useMemo(() => extractBashEntries(events), [events]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (entries.length > 0 && !entries.find((e) => e.id === activeId)) {
      setActiveId(entries[entries.length - 1].id);
    }
  }, [entries, activeId]);

  if (entries.length === 0) return null;

  const active = entries.find((e) => e.id === activeId) ?? entries[entries.length - 1];

  return (
    <div className="flex h-64 flex-col border-t border-zinc-800 bg-black">
      <div className="flex gap-1 border-b border-zinc-800 bg-zinc-950 px-2 py-1 text-xs">
        {entries.map((e) => (
          <button
            key={e.id}
            onClick={() => setActiveId(e.id)}
            className={`rounded px-2 py-0.5 font-mono ${
              e.id === active.id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {e.command.slice(0, 30)}{e.command.length > 30 ? '…' : ''}
            {e.result === null && ' ⏳'}
            {e.isError && ' ❌'}
          </button>
        ))}
      </div>
      <div className="flex-1">
        <TerminalView key={active.id} entry={active} />
      </div>
    </div>
  );
}
