import { useState } from 'react';
import type { ReviewThread } from '../../server/vcs/adapter';

export function CommentsPanel({
  threads,
  onFix,
  onReply,
}: {
  threads: ReviewThread[];
  onFix: (threadId: string) => void;
  onReply: (threadId: string, body: string) => void;
}) {
  const unresolved = threads.filter((t) => !t.isResolved);

  if (unresolved.length === 0) return null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Review Comments ({unresolved.length})
      </h2>
      <div className="flex flex-col gap-3">
        {unresolved.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            onFix={() => onFix(thread.id)}
            onReply={(body) => onReply(thread.id, body)}
          />
        ))}
      </div>
    </div>
  );
}

function ThreadCard({
  thread,
  onFix,
  onReply,
}: {
  thread: ReviewThread;
  onFix: () => void;
  onReply: (body: string) => void;
}) {
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState('');

  const firstComment = thread.comments[0];
  const humanComments = thread.comments.filter((c) => !c.isBot);

  if (humanComments.length === 0) return null;

  const lastHuman = humanComments[humanComments.length - 1];

  function submitReply() {
    if (!replyText.trim()) return;
    onReply(replyText.trim());
    setReplyText('');
    setShowReply(false);
  }

  return (
    <div className="rounded border border-zinc-700 bg-zinc-950 p-3">
      {firstComment.path && (
        <div className="mb-1 text-xs font-mono text-zinc-500">
          {firstComment.path}{firstComment.line ? `:${firstComment.line}` : ''}
        </div>
      )}
      <div className="flex items-start gap-2">
        <span className="text-xs text-zinc-500 shrink-0">{lastHuman.author}:</span>
        <p className="text-xs text-zinc-300 flex-1 line-clamp-4">{lastHuman.body}</p>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onFix}
          className="rounded bg-blue-700 px-2 py-0.5 text-xs text-white hover:bg-blue-600"
        >
          Fix
        </button>
        <button
          type="button"
          onClick={() => setShowReply((v) => !v)}
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        >
          Reply
        </button>
      </div>
      {showReply && (
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitReply()}
            placeholder="Reply…"
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={submitReply}
            className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-600"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
