import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { send, subscribe } from '../lib/ws';
import { useRepos } from '../hooks/use-repos';

function RegisterRepoInline({ onRegistered }: { onRegistered: () => void }) {
  const [path, setPath] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!path.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/repo/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.trim() }) });
      if (!r.ok) { const body = await r.json().catch(() => ({})); throw new Error((body as { error?: string }).error ?? r.statusText); }
      onRegistered();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="my-2 rounded border border-zinc-700 bg-zinc-800 p-2 text-xs">
      <div className="mb-1 text-zinc-400">Register a repo</div>
      <div className="flex gap-2">
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/absolute/path/to/repo" className="flex-1 rounded bg-zinc-900 px-2 py-1 outline-none ring-1 ring-zinc-700 focus:ring-blue-500" />
        <button onClick={submit} disabled={!path.trim() || busy} className="rounded bg-blue-600 px-2 py-1 font-medium text-white disabled:opacity-40">{busy ? '…' : 'Register'}</button>
      </div>
      {err && <div className="mt-1 text-red-300">{err}</div>}
    </div>
  );
}

const TEMPLATES = [
  { id: 'quick-fix', title: 'Quick fix', blurb: 'Typo/tiny bug. Auto-accept + auto-PR.' },
  { id: 'standard', title: 'Standard', blurb: 'Normal feature/bugfix. Manual accept.' },
  { id: 'exploration', title: 'Exploration', blurb: 'Ambiguous scope. Brainstorm first; no branch yet.' },
] as const;

type Preview = {
  branch: string;
  localBranchExists: boolean;
  duplicateTopic: { id: string; title: string } | null;
} | null;

export function NewTopicModal({ onClose }: { onClose: () => void }) {
  const repos = useRepos();
  const [, navigate] = useLocation();
  const [template, setTemplate] = useState<'quick-fix' | 'standard' | 'exploration'>('standard');
  const [repoId, setRepoId] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [title, setTitle] = useState('');
  const [ticketKey, setTicketKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [branchOverride, setBranchOverride] = useState('');
  const [preview, setPreview] = useState<Preview>(null);
  const [validating, setValidating] = useState(false);
  const autoPreviewToken = useRef(0);

  useEffect(() => {
    if (!repoId && repos.length > 0) setRepoId(repos[0].id);
  }, [repos, repoId]);

  // Auto-preview when auto-derived (no override): debounce typing by 400ms.
  useEffect(() => {
    if (branchOverride.trim()) return;
    if (!repoId || !title.trim()) { setPreview(null); return; }
    const token = ++autoPreviewToken.current;
    const t = setTimeout(() => {
      if (token !== autoPreviewToken.current) return;
      send({ type: 'client.topic.previewBranch', payload: { repoId, title: title.trim(), ticketKey: ticketKey.trim() || undefined } });
    }, 400);
    return () => clearTimeout(t);
  }, [repoId, title, ticketKey, branchOverride]);

  function validateOverride() {
    if (!repoId || !branchOverride.trim()) return;
    setValidating(true);
    send({ type: 'client.topic.previewBranch', payload: { repoId, title: title.trim(), ticketKey: ticketKey.trim() || undefined, override: branchOverride.trim() } });
  }

  useEffect(() => {
    return subscribe((m) => {
      if (m.type === 'server.topic.branchPreview') {
        setPreview(m.payload);
        setValidating(false);
      } else if (m.type === 'server.topic.created') {
        setSubmitting(false);
        onClose();
        navigate(`/topic/${m.payload.topicId}`);
      } else if (m.type === 'server.topic.error') {
        if (m.payload.ctx === 'create') { setError(m.payload.message); setSubmitting(false); }
        if (m.payload.ctx === 'previewBranch') { setValidating(false); }
      }
    });
  }, [onClose, navigate]);

  const conflict = !!preview && (preview.localBranchExists || !!preview.duplicateTopic);
  const canSubmit = !!repoId && !!title.trim() && !submitting && !conflict && (!branchOverride.trim() || !!preview);

  function submit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    send({
      type: 'client.topic.create',
      payload: {
        repoId, template, title: title.trim(),
        ticketKey: ticketKey.trim() || undefined,
        branchOverride: branchOverride.trim() || undefined,
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

        <label className="mb-1 block text-sm">
          <span className="text-zinc-300">Repo</span>
          <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500" disabled={repos.length === 0}>
            {repos.length === 0 ? <option value="">(register a repo first)</option> : null}
            {repos.map((r) => {
              const label = r.canonicalOwner && r.canonicalName ? `${r.canonicalOwner}/${r.canonicalName}` : r.path;
              return <option key={r.id} value={r.id}>{label}</option>;
            })}
          </select>
        </label>
        <div className="mb-3 text-right">
          <button type="button" onClick={() => setShowRegister((v) => !v)} className="text-xs text-blue-400 hover:underline">
            {showRegister ? '— hide' : '+ Add repo'}
          </button>
        </div>
        {(showRegister || repos.length === 0) && (
          <RegisterRepoInline onRegistered={() => setShowRegister(false)} />
        )}

        <label className="mb-3 block text-sm">
          <span className="text-zinc-300">Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Fix login copy" className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500" />
        </label>

        <label className="mb-3 block text-sm">
          <span className="text-zinc-300">Ticket (optional)</span>
          <input type="text" value={ticketKey} onChange={(e) => setTicketKey(e.target.value)} placeholder="ABC-123" className="mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-blue-500" />
        </label>

        {template !== 'exploration' && (
          <div className="mb-3">
            <div className="mb-1 text-sm text-zinc-300">Branch</div>
            <div className="flex gap-2">
              <input
                type="text"
                value={branchOverride}
                onChange={(e) => { setBranchOverride(e.target.value); setPreview(null); }}
                placeholder={preview?.branch ?? 'auto (gh_user/ticket_slug)'}
                className="flex-1 rounded bg-zinc-800 px-3 py-2 font-mono text-xs outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={validateOverride}
                disabled={!branchOverride.trim() || validating}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                {validating ? 'Checking…' : 'Validate'}
              </button>
            </div>
            {preview && !conflict && (
              <div className="mt-1 text-xs text-emerald-300">✓ Will create <span className="font-mono">{preview.branch}</span></div>
            )}
            {preview?.duplicateTopic && (
              <div className="mt-1 text-xs text-red-300">
                ⚠ Duplicates existing topic “{preview.duplicateTopic.title}”. Edit the title/ticket or override the branch.
              </div>
            )}
            {preview?.localBranchExists && !preview.duplicateTopic && (
              <div className="mt-1 text-xs text-amber-300">
                ⚠ Branch <span className="font-mono">{preview.branch}</span> already exists locally. Pick a different name or delete it first.
              </div>
            )}
          </div>
        )}

        {error && <div className="mb-3 rounded bg-red-900/40 p-2 text-xs text-red-200">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button>
          <button onClick={submit} disabled={!canSubmit} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">{submitting ? 'Creating…' : 'Create topic'}</button>
        </div>
      </div>
    </div>
  );
}
