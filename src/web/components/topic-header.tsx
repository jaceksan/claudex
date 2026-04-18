import { useState } from 'react';
import type { TopicDetailBundle } from '../../server/ws/topic-envelope';
import type { PR } from '../../server/vcs/adapter';

type TopicMeta = TopicDetailBundle['topic'];

function stagePillClass(phase: string): string {
  switch (phase) {
    case 'Exploring': return 'bg-violet-900/40 text-violet-200';
    case 'Draft': return 'bg-zinc-800 text-zinc-200';
    case 'Open': return 'bg-emerald-900/40 text-emerald-200';
    case 'Merged': return 'bg-sky-900/40 text-sky-200';
    case 'Closed': return 'bg-zinc-800 text-zinc-500';
    default: return 'bg-zinc-800 text-zinc-200';
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="ml-1 rounded px-1 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
      title="Copy branch name"
    >
      {copied ? '✓' : 'copy'}
    </button>
  );
}

export function TopicHeader({
  topic,
  pr,
  onBack,
}: {
  topic: TopicMeta;
  pr: PR | undefined;
  onBack: () => void;
}) {
  return (
    <div className="border-b border-zinc-800 bg-zinc-950 px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-zinc-400 hover:text-zinc-100"
          title="Back to dashboard"
        >
          ←
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {topic.ticketKey && (
              <span className="text-xs text-zinc-400 font-mono">{topic.ticketKey}</span>
            )}
            <span className="text-sm font-medium text-zinc-100 truncate">{topic.title}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stagePillClass(topic.phase)}`}>
              {topic.phase}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500 flex-wrap">
            {topic.topicBranch && (
              <span className="flex items-center">
                <span className="font-mono text-zinc-400">{topic.topicBranch}</span>
                <CopyButton text={topic.topicBranch} />
              </span>
            )}
            {pr && (
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300"
              >
                PR #{pr.number} ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
