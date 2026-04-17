import type { GitInfo } from '../../server/git';

export function GitBadge({ info, compact = false }: { info: GitInfo | null; compact?: boolean }) {
  if (!info || !info.isRepo) return null;
  const dirtyTotal = info.dirty ? info.dirty.staged + info.dirty.unstaged + info.dirty.untracked : 0;
  const dirty = dirtyTotal > 0;
  const branchLabel = info.detached ? `(${info.branch})` : info.branch ?? '?';

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400" title={info.lastCommit ? `${info.lastCommit.sha} ${info.lastCommit.subject}` : undefined}>
        <span className="text-emerald-400">⎇ {branchLabel}</span>
        {dirty && <span className="text-amber-400" title={`${info.dirty?.staged ?? 0} staged · ${info.dirty?.unstaged ?? 0} unstaged · ${info.dirty?.untracked ?? 0} untracked`}>●{dirtyTotal}</span>}
        {info.ahead !== undefined && (info.ahead > 0 || (info.behind ?? 0) > 0) && (
          <span className="text-zinc-500">↑{info.ahead}↓{info.behind ?? 0}</span>
        )}
        {info.pr && (
          <span className={info.pr.state === 'OPEN' ? 'text-blue-300' : 'text-zinc-500'} title={info.pr.title}>
            PR #{info.pr.number}
            {info.pr.checks && (info.pr.checks.failing > 0
              ? <span className="ml-1 text-red-400">✗{info.pr.checks.failing}</span>
              : info.pr.checks.pending > 0
                ? <span className="ml-1 text-yellow-400">●</span>
                : <span className="ml-1 text-emerald-400">✓</span>)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
      <span className="text-emerald-400">⎇ {branchLabel}</span>
      {info.upstream && (info.ahead || info.behind) ? (
        <span className="text-zinc-500">↑{info.ahead ?? 0} ↓{info.behind ?? 0} <span className="text-zinc-600">vs {info.upstream}</span></span>
      ) : info.upstream ? (
        <span className="text-zinc-500" title={info.upstream}>up to date</span>
      ) : null}
      {dirty && (
        <span className="text-amber-400" title={`${info.dirty?.staged ?? 0} staged · ${info.dirty?.unstaged ?? 0} unstaged · ${info.dirty?.untracked ?? 0} untracked`}>
          ● {[
            info.dirty?.staged ? `${info.dirty.staged} staged` : null,
            info.dirty?.unstaged ? `${info.dirty.unstaged} unstaged` : null,
            info.dirty?.untracked ? `${info.dirty.untracked} untracked` : null,
          ].filter(Boolean).join(' · ')}
        </span>
      )}
      {info.lastCommit && (
        <span className="truncate max-w-md text-zinc-500" title={info.lastCommit.subject}>
          <span className="font-mono text-zinc-400">{info.lastCommit.sha}</span> {info.lastCommit.subject} <span className="text-zinc-600">· {info.lastCommit.relative}</span>
        </span>
      )}
      {info.remote && (
        <span className="text-zinc-500">{info.remote.owner}/{info.remote.repo}</span>
      )}
      {info.pr && (
        <a
          href={info.pr.url}
          target="_blank"
          rel="noreferrer"
          className={`underline-offset-2 hover:underline ${info.pr.state === 'OPEN' ? 'text-blue-300' : 'text-zinc-500'}`}
          title={info.pr.title}
        >
          PR #{info.pr.number} · {info.pr.state}
          {info.pr.checks && (info.pr.checks.failing > 0
            ? <span className="ml-1 text-red-400">✗ {info.pr.checks.failing}</span>
            : info.pr.checks.pending > 0
              ? <span className="ml-1 text-yellow-400">● {info.pr.checks.pending}</span>
              : <span className="ml-1 text-emerald-400">✓ {info.pr.checks.passing}</span>)}
        </a>
      )}
    </div>
  );
}
