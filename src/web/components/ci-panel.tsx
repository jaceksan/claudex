import { useState } from 'react';
import type { Check } from '../../server/vcs/adapter';

/**
 * Sort-order for advisory checks: ran-and-finished first (success then
 * failure/timeout/neutral), then still-running, then skipped/cancelled last.
 * Users care about "did something happen?" — skipped rows at the bottom.
 */
function checkOrder(c: Check): number {
  if (c.status !== 'completed') return 2;                 // running/queued
  if (c.conclusion === 'skipped' || c.conclusion === 'cancelled') return 3;
  if (c.conclusion === 'success') return 0;               // green first
  return 1;                                               // failure/timeout/neutral
}

export function CiPanel({
  checks,
  required,
  watchEnabled,
  loading,
  onFix,
  onWatchToggle,
  onRefresh,
}: {
  checks: Check[];
  required: string[];
  watchEnabled: boolean;
  loading?: boolean;
  onFix: (checkName: string) => void;
  onWatchToggle: (enable: boolean) => void;
  onRefresh?: () => void;
}) {
  const [showAdvisory, setShowAdvisory] = useState(false);

  const requiredChecks = checks.filter((c) => required.includes(c.name));
  const advisoryChecks = checks
    .filter((c) => !required.includes(c.name))
    .slice()
    .sort((a, b) => checkOrder(a) - checkOrder(b) || a.name.localeCompare(b.name));

  const failing = requiredChecks.filter((c) => c.conclusion === 'failure');
  const passing = requiredChecks.filter((c) => c.conclusion === 'success');
  const pending = requiredChecks.filter((c) => c.status !== 'completed');

  const anyRunning = checks.some((c) => c.status === 'in_progress' || c.status === 'queued');
  const rollup = failing.length > 0 ? 'failing' : pending.length > 0 ? 'pending' : 'passing';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 flex items-center gap-2">
          CI Checks
          {(loading || anyRunning) && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" title={loading ? 'Loading…' : 'Some checks still running'} />
          )}
        </h2>
        <div className="flex items-center gap-2">
          <RollupBadge rollup={rollup} anyRunning={anyRunning} />
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-500"
              title="Re-poll CI now"
            >
              ↻
            </button>
          )}
          <button
            type="button"
            onClick={() => onWatchToggle(!watchEnabled)}
            className={`rounded border px-2 py-0.5 text-xs ${
              watchEnabled
                ? 'border-blue-600 text-blue-300 hover:border-blue-400'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
            title={watchEnabled ? 'Stop watching CI' : 'Watch CI (get OS notifications)'}
          >
            {watchEnabled ? '👁 Watching' : '👁 Watch'}
          </button>
        </div>
      </div>

      {requiredChecks.length === 0 && checks.length === 0 && (
        <div className="text-xs text-zinc-500">
          {loading ? 'Waiting for first check results from the provider…' : 'No checks found.'}
        </div>
      )}

      {failing.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {failing.map((c) => (
            <div key={c.name} className="flex items-center justify-between rounded border border-red-900/40 bg-red-950/20 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-red-400">✗</span>
                <span className="text-xs text-zinc-300 font-mono">{c.name}</span>
              </div>
              <button
                type="button"
                onClick={() => onFix(c.name)}
                className="rounded bg-red-800 px-2 py-0.5 text-xs text-white hover:bg-red-700"
              >
                Fix
              </button>
            </div>
          ))}
        </div>
      )}

      {passing.map((c) => (
        <div key={c.name} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
          <span className="text-emerald-500">✓</span>
          <span className="font-mono">{c.name}</span>
        </div>
      ))}

      {pending.map((c) => (
        <div key={c.name} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
          <span className={c.status === 'in_progress' ? 'text-amber-400 animate-pulse' : 'text-amber-500'}>
            {c.status === 'in_progress' ? '▶' : '⋯'}
          </span>
          <span className="font-mono">{c.name}</span>
          <span className="ml-auto text-[10px] text-zinc-600">{c.status === 'in_progress' ? 'running' : c.status}</span>
        </div>
      ))}

      {advisoryChecks.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowAdvisory((v) => !v)}
            className="text-xs text-zinc-600 hover:text-zinc-400"
          >
            {showAdvisory ? '▾' : '▸'} {advisoryChecks.length} advisory check{advisoryChecks.length !== 1 ? 's' : ''}
          </button>
          {showAdvisory && (
            <div className="mt-1 flex flex-col gap-1">
              {advisoryChecks.map((c) => (
                <div key={c.name} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-600">
                  <CheckIcon conclusion={c.conclusion} />
                  <span className="font-mono">{c.name}</span>
                  <span className="ml-auto text-zinc-700">ⓘ advisory</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RollupBadge({ rollup, anyRunning }: { rollup: 'passing' | 'failing' | 'pending'; anyRunning: boolean }) {
  if (rollup === 'passing') return <span className="text-xs text-emerald-400">✓ Required passing</span>;
  if (rollup === 'failing') return <span className="text-xs text-red-400">✗ CI failing</span>;
  return <span className="text-xs text-amber-400">{anyRunning ? '▶ Running' : '⋯ Pending'}</span>;
}

function CheckIcon({ conclusion }: { conclusion: Check['conclusion'] }) {
  if (conclusion === 'success') return <span className="text-emerald-600">✓</span>;
  if (conclusion === 'failure') return <span className="text-red-600">✗</span>;
  return <span className="text-zinc-600">○</span>;
}
