import { useEffect, useState } from 'react';
import { send, subscribe } from '../lib/ws';
import { useRepos } from '../hooks/use-repos';

const TEMPLATES = [
  { id: 'quick-fix', title: 'Quick fix', blurb: 'Typo/tiny bug. Auto-accept + auto-PR.' },
  { id: 'standard', title: 'Standard', blurb: 'Normal feature/bugfix. Manual accept.' },
  { id: 'exploration', title: 'Exploration', blurb: 'Ambiguous scope. Brainstorm first; no branch yet.' },
] as const;

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;

export function NewTopicModal({ onClose }: { onClose: () => void }) {
  const repos = useRepos();
  const [template, setTemplate] = useState<'quick-fix' | 'standard' | 'exploration'>('standard');
  const [repoId, setRepoId] = useState('');
  const [title, setTitle] = useState('');
  const [ticketKey, setTicketKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [effort, setEffort] = useState<typeof EFFORTS[number]>('medium');
  const [mode, setMode] = useState<typeof MODES[number]>('acceptEdits');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!repoId && repos.length > 0) setRepoId(repos[0].id);
  }, [repos, repoId]);

  useEffect(() => {
    setMode(template === 'exploration' ? 'plan' : 'acceptEdits');
    setEffort(template === 'quick-fix' ? 'low' : 'medium');
  }, [template]);

  useEffect(() => {
    return subscribe((m) => {
      if (m.type === 'server.topic.created') { setSubmitting(false); onClose(); }
      else if (m.type === 'server.topic.error') {
        if (m.payload.ctx === 'create') { setError(m.payload.message); setSubmitting(false); }
      }
    });
  }, [onClose]);

  const canSubmit = !!repoId && !!title.trim() && !submitting;

  function submit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    send({
      type: 'client.topic.create',
      payload: {
        repoId, template, title: title.trim(),
        ticketKey: ticketKey.trim() || undefined,
        firstTask: { prompt: prompt.trim() || undefined, effort, permissionMode: mode },
      },
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">New topic</h2>

        <div className="mb-4">
          <div className="mb-2 text-xs text-zinc-400">Template</div>
          <div className="grid grid-cols-3 gap-2">
            {TEMPLATES.map((t) => (
              <button key={t.id} onClick={() => setTemplate(t.id)} className={`rounded border p-2 text-left text-xs ${template === t.id ? 'border-blue-500 bg-blue-950/40' : 'border-zinc-700 bg-zinc-800'}`}>
                <div className="font-medium">{t.title}</div>
                <div className="text-zinc-500">{t.blurb}</div>
              </button>
            ))}
          </div>
        </div>

        <label className="mb-3 block text-sm">
          <span className="text-zinc-300">Repo</span>
          <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500" disabled={repos.length === 0}>
            {repos.length === 0 ? <option value="">(register a repo first)</option> : null}
            {repos.map((r) => <option key={r.id} value={r.id}>{r.canonicalOwner}/{r.canonicalName || r.path}</option>)}
          </select>
        </label>

        <label className="mb-3 block text-sm">
          <span className="text-zinc-300">Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Fix login copy" className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500" />
        </label>

        <label className="mb-3 block text-sm">
          <span className="text-zinc-300">Ticket (optional)</span>
          <input type="text" value={ticketKey} onChange={(e) => setTicketKey(e.target.value)} placeholder="ABC-123" className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500" />
        </label>

        <label className="mb-3 block text-sm">
          <span className="text-zinc-300">Initial prompt {template === 'exploration' ? '(optional)' : ''}</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="What should the session do first?" className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500" />
        </label>

        <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
          <label className="block">
            <span className="text-zinc-300">Effort</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value as typeof EFFORTS[number])} className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 outline-none ring-1 ring-zinc-700 focus:ring-blue-500">
              {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-zinc-300">Permission</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof MODES[number])} className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 outline-none ring-1 ring-zinc-700 focus:ring-blue-500">
              {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        </div>

        {error && <div className="mb-3 rounded bg-red-900/40 p-2 text-xs text-red-200">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button>
          <button onClick={submit} disabled={!canSubmit} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">{submitting ? 'Creating…' : 'Create topic'}</button>
        </div>
      </div>
    </div>
  );
}
