import { useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import ReactDiffViewer from 'react-diff-viewer-continued';
import type { StreamEvent, ToolUseBlock, ToolResultBlock } from '../../server/stream-json/types';

import 'highlight.js/styles/github-dark.css';

function Collapsible({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-800/60"
      >
        <span className="text-zinc-500">{open ? '▼' : '▶'}</span>
        {summary}
      </button>
      {open && <div className="border-t border-zinc-800 p-3">{children}</div>}
    </div>
  );
}

function ToolUseView({ block }: { block: ToolUseBlock }) {
  if (block.name === 'ExitPlanMode') {
    const plan = (block.input.plan as string) ?? '';
    return (
      <div className="rounded border-l-4 border-purple-500 bg-purple-950/20 p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-300">Plan</div>
        <div className="prose prose-invert prose-sm max-w-none">
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{plan}</Markdown>
        </div>
      </div>
    );
  }

  if (block.name === 'Edit') {
    const oldStr = (block.input.old_string as string) ?? '';
    const newStr = (block.input.new_string as string) ?? '';
    const filePath = (block.input.file_path as string) ?? '';
    return (
      <Collapsible summary={<span><span className="text-zinc-400">Edit</span> <span className="font-mono text-xs text-zinc-500">{filePath}</span></span>}>
        <ReactDiffViewer oldValue={oldStr} newValue={newStr} splitView useDarkTheme hideLineNumbers={false} />
      </Collapsible>
    );
  }

  if (block.name === 'Write') {
    const content = (block.input.content as string) ?? '';
    const filePath = (block.input.file_path as string) ?? '';
    return (
      <Collapsible summary={<span><span className="text-zinc-400">Write</span> <span className="font-mono text-xs text-zinc-500">{filePath}</span></span>}>
        <ReactDiffViewer oldValue="" newValue={content} splitView={false} useDarkTheme />
      </Collapsible>
    );
  }

  return (
    <Collapsible summary={<span><span className="text-blue-400">{block.name}</span></span>}>
      <pre className="overflow-auto text-xs text-zinc-300">{JSON.stringify(block.input, null, 2)}</pre>
    </Collapsible>
  );
}

function ToolResultView({ block }: { block: ToolResultBlock }) {
  const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);
  const border = block.is_error ? 'border-red-500/70' : 'border-zinc-700';
  return (
    <Collapsible summary={
      <span className={block.is_error ? 'text-red-400' : 'text-zinc-400'}>
        tool result {block.is_error ? '(error)' : ''}
      </span>
    }>
      <pre className={`overflow-auto max-h-96 whitespace-pre-wrap text-xs ${block.is_error ? 'text-red-300' : 'text-zinc-200'} rounded border ${border} p-2`}>
        {text}
      </pre>
    </Collapsible>
  );
}

export function EventView({ event }: { event: StreamEvent }) {
  if (event.type === 'system') {
    return <div className="text-xs text-zinc-500">system: {event.subtype} ({event.session_id.slice(0, 8)})</div>;
  }

  if (event.type === 'assistant') {
    return (
      <div className="space-y-2">
        {event.message.content.map((block, i) => {
          if (block.type === 'text') {
            return (
              <div key={i} className="prose prose-invert prose-sm max-w-none">
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{block.text}</Markdown>
              </div>
            );
          }
          if (block.type === 'tool_use') {
            return <ToolUseView key={i} block={block} />;
          }
          return null;
        })}
      </div>
    );
  }

  if (event.type === 'user') {
    const content = Array.isArray(event.message.content) ? event.message.content : [{ type: 'text' as const, text: event.message.content }];
    return (
      <div className="space-y-2">
        {content.map((block, i) => {
          if (block.type === 'text') {
            return <div key={i} className="rounded bg-zinc-800/40 p-2 text-sm text-zinc-200">{block.text}</div>;
          }
          if (block.type === 'tool_result') {
            return <ToolResultView key={i} block={block} />;
          }
          return null;
        })}
      </div>
    );
  }

  if (event.type === 'result') {
    const ok = !event.is_error;
    return (
      <div className={`rounded border px-3 py-2 text-sm ${ok ? 'border-zinc-700 text-zinc-300' : 'border-red-500/40 text-red-300'}`}>
        Session {ok ? 'finished' : 'crashed'} · {event.subtype} · ${(event.total_cost_usd ?? 0).toFixed(4)}
      </div>
    );
  }

  return null;
}
