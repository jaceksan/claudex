import { useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';
import type { StreamEvent, ToolUseBlock, ToolResultBlock } from '../../server/stream-json/types';

import 'highlight.js/styles/github-dark.css';
import '@git-diff-view/react/styles/diff-view.css';

function langFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
    sh: 'bash', bash: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml',
    md: 'markdown', html: 'html', css: 'css', scss: 'scss',
    sql: 'sql', toml: 'toml', xml: 'xml',
  };
  return map[ext] ?? 'plaintext';
}

function FileDiff({ oldValue, newValue, filePath, split = true }: { oldValue: string; newValue: string; filePath: string; split?: boolean }) {
  const file = useMemo(() => {
    const lang = langFromPath(filePath);
    const f = generateDiffFile(filePath, oldValue, filePath, newValue, lang, lang);
    f.initTheme('dark');
    f.init();
    if (split) f.buildSplitDiffLines();
    else f.buildUnifiedDiffLines();
    return f;
  }, [oldValue, newValue, filePath, split]);
  return (
    <DiffView
      diffFile={file}
      diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewTheme="dark"
      diffViewHighlight
      diffViewWrap
      diffViewFontSize={12}
    />
  );
}

function Collapsible({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-zinc-800/60"
      >
        <span className="text-zinc-500">{open ? '▼' : '▶'}</span>
        {summary}
      </button>
      {open && <div className="border-t border-zinc-800 p-2">{children}</div>}
    </div>
  );
}

function summaryForTool(block: ToolUseBlock): string {
  const i = block.input;
  if (block.name === 'Bash') return String(i.command ?? '').slice(0, 120);
  if (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') return String(i.file_path ?? '');
  if (block.name === 'Glob' || block.name === 'Grep') return String(i.pattern ?? '');
  return '';
}

function ToolUseView({ block }: { block: ToolUseBlock }) {
  if (block.name === 'ExitPlanMode') {
    const plan = (block.input.plan as string) ?? '';
    return (
      <div className="rounded border-l-4 border-purple-500 bg-purple-950/20 p-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-purple-300">Plan</div>
        <div className="prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed">
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
      <Collapsible defaultOpen summary={<><span className="text-amber-400">Edit</span> <span className="font-mono text-zinc-400">{filePath}</span></>}>
        <FileDiff oldValue={oldStr} newValue={newStr} filePath={filePath} />
      </Collapsible>
    );
  }

  if (block.name === 'Write') {
    const content = (block.input.content as string) ?? '';
    const filePath = (block.input.file_path as string) ?? '';
    return (
      <Collapsible defaultOpen summary={<><span className="text-amber-400">Write</span> <span className="font-mono text-zinc-400">{filePath}</span></>}>
        <FileDiff oldValue="" newValue={content} filePath={filePath} split={false} />
      </Collapsible>
    );
  }

  const summary = summaryForTool(block);
  return (
    <Collapsible summary={<><span className="text-amber-400">{block.name}</span> {summary && <span className="font-mono text-zinc-400 truncate">{summary}</span>}</>}>
      <pre className="overflow-auto whitespace-pre-wrap text-xs text-zinc-300">{JSON.stringify(block.input, null, 2)}</pre>
    </Collapsible>
  );
}

function ToolResultView({ block }: { block: ToolResultBlock }) {
  const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);

  // Tool errors — including "Path does not exist" and similar speculative-call failures —
  // always render as a muted one-line collapsible. LLM exploration routinely trips these;
  // showing a scary red block every time is noisy and obscures the real signal when the
  // error is actually fatal. User can click to expand the full text either way.
  if (block.is_error) {
    const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '(empty)';
    const summary = firstLine.length > 140 ? firstLine.slice(0, 137) + '…' : firstLine;
    return (
      <Collapsible summary={<span className="text-zinc-500"><span className="text-amber-500/80">⚠</span> tool error · <span className="text-zinc-400">{summary}</span></span>}>
        <pre className="overflow-auto max-h-96 whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-400">{text}</pre>
      </Collapsible>
    );
  }

  const short = text.length <= 400 && text.split('\n').length <= 8;
  if (short) {
    return (
      <pre className="overflow-auto whitespace-pre-wrap rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-300">
        {text || <span className="italic text-zinc-500">(empty)</span>}
      </pre>
    );
  }

  return (
    <Collapsible summary={<span className="text-zinc-500">result · {text.split('\n').length} lines</span>}>
      <pre className="overflow-auto max-h-96 whitespace-pre-wrap text-xs text-zinc-300">{text}</pre>
    </Collapsible>
  );
}

export function EventView({ event }: { event: StreamEvent }) {
  // Don't render streaming delta events — they're collapsed into the live streaming buffer in SessionPage.
  if (event.type === 'stream_event') return null;

  // Skip system events entirely — they're noise for the activity feed.
  if (event.type === 'system') return null;

  if (event.type === 'assistant') {
    return (
      <div className="space-y-1.5">
        {event.message.content.map((block, i) => {
          if (block.type === 'text') {
            if (!block.text.trim()) return null;
            return (
              <div key={i} className="prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed">
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
    // Filter out text blocks that are empty and tool_result-only user messages render tightly.
    const blocks = content.filter((b) => {
      if (typeof b !== 'object') return false;
      if (b.type === 'text') return Boolean((b.text ?? '').trim());
      return true;
    });
    if (blocks.length === 0) return null;
    return (
      <div className="space-y-1.5">
        {blocks.map((block, i) => {
          if (block.type === 'text') {
            const long = block.text.length > 400 || block.text.split('\n').length > 8;
            const md = (
              <div className="prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed">
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{block.text}</Markdown>
              </div>
            );
            if (long) {
              return (
                <Collapsible
                  key={i}
                  summary={<span className="text-blue-400">user message · {block.text.split('\n').length} lines</span>}
                >
                  {md}
                </Collapsible>
              );
            }
            return (
              <div key={i} className="rounded border-l-2 border-blue-500/60 bg-blue-950/10 px-3 py-1.5">
                {md}
              </div>
            );
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
      <div className={`rounded border px-2 py-1 text-xs ${ok ? 'border-zinc-800 text-zinc-500' : 'border-red-500/40 text-red-300'}`}>
        turn {ok ? 'finished' : `failed (${event.subtype})`} · ${(event.total_cost_usd ?? 0).toFixed(4)}
        {event.duration_ms !== undefined && ` · ${(event.duration_ms / 1000).toFixed(1)}s`}
      </div>
    );
  }

  return null;
}
