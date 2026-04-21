import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { send, subscribe } from '../lib/ws';
import type { InboxItem } from '../../server/ws/topic-envelope';

/**
 * Dashboard-wide attention queue. Shows every topic that needs the user's
 * eyes — failing CI, unresolved review comments, behind-main, rebase in
 * progress — grouped by kind, highest priority first. Clicking a row
 * navigates into the topic page where the concrete action lives.
 */
export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [, navigate] = useLocation();

  useEffect(() => {
    const unsub = subscribe((m) => {
      if (m.type === 'server.inbox.state') setItems(m.payload.items);
    });
    send({ type: 'client.inbox.list', payload: {} });
    const t = setInterval(() => send({ type: 'client.inbox.list', payload: {} }), 30_000);
    return () => { unsub(); clearInterval(t); };
  }, []);

  const groupOrder: InboxItem['kind'][] = ['failing-ci', 'unresolved-comments', 'rebase-in-progress', 'behind-main'];
  const grouped = new Map<InboxItem['kind'], InboxItem[]>();
  for (const it of items ?? []) {
    const g = grouped.get(it.kind) ?? [];
    g.push(it);
    grouped.set(it.kind, g);
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <button
          type="button"
          onClick={() => send({ type: 'client.inbox.list', payload: {} })}
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-500"
          title="Re-compute now"
        >
          ↻ refresh
        </button>
      </div>
      {items === null && <div className="text-zinc-500">Loading…</div>}
      {items !== null && items.length === 0 && (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-center text-zinc-500">
          Nothing to do. Every topic is clean.
        </div>
      )}
      {items !== null && items.length > 0 && (
        <div className="flex flex-col gap-6">
          {groupOrder.map((k) => {
            const g = grouped.get(k) ?? [];
            if (g.length === 0) return null;
            return (
              <section key={k}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {labelFor(k)} ({g.length})
                </h2>
                <div className="flex flex-col gap-1">
                  {g.map((it) => (
                    <button
                      key={`${it.topicId}-${it.kind}-${it.hint ?? ''}`}
                      type="button"
                      onClick={() => navigate(`/topic/${it.topicId}`)}
                      className={`flex items-center justify-between rounded border px-3 py-2 text-left hover:border-zinc-500 ${borderFor(k)} bg-zinc-900`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-zinc-100">{it.topicTitle}</div>
                        <div className="truncate text-xs text-zinc-500">{it.summary}</div>
                      </div>
                      <div className="shrink-0 ml-3 flex items-center gap-2">
                        <span className="text-xs font-mono text-zinc-600">{it.repoName}</span>
                        <span className="text-xs text-zinc-700">→</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function labelFor(k: InboxItem['kind']): string {
  switch (k) {
    case 'failing-ci': return 'Failing CI';
    case 'unresolved-comments': return 'Unresolved review comments';
    case 'rebase-in-progress': return 'Rebase in progress';
    case 'behind-main': return 'Behind main';
  }
}

function borderFor(k: InboxItem['kind']): string {
  switch (k) {
    case 'failing-ci': return 'border-red-900/40';
    case 'unresolved-comments': return 'border-amber-900/40';
    case 'rebase-in-progress': return 'border-blue-900/40';
    case 'behind-main': return 'border-zinc-800';
  }
}
