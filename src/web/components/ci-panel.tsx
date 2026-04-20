import { useState } from 'react';
import type { Check } from '../../server/vcs/adapter';

type Bucket = 'errors' | 'running' | 'passed' | 'skipped';

function bucketOf(c: Check): Bucket {
  if (c.status !== 'completed') return 'running';
  if (c.conclusion === 'failure' || c.conclusion === 'timed_out') return 'errors';
  if (c.conclusion === 'success') return 'passed';
  return 'skipped'; // skipped / cancelled / neutral / null
}

export function CiPanel({
  checks,
  watchEnabled,
  loading,
  onFix,
  onWatchToggle,
  onRefresh,
}: {
  checks: Check[];
  /** Unused; kept in the props for future "mark non-voting" work. */
  required?: string[];
  watchEnabled: boolean;
  loading?: boolean;
  onFix: (checkName: string) => void;
  onWatchToggle: (enable: boolean) => void;
  onRefresh?: () => void;
}) {
  const [showPassed, setShowPassed] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);

  const sorted = checks.slice().sort((a, b) => a.name.localeCompare(b.name));
  const errors = sorted.filter((c) => bucketOf(c) === 'errors');
  const running = sorted.filter((c) => bucketOf(c) === 'running');
  const passed = sorted.filter((c) => bucketOf(c) === 'passed');
  const skipped = sorted.filter((c) => bucketOf(c) === 'skipped');

  const anyRunning = running.length > 0;
  const rollup: 'passing' | 'failing' | 'pending' =
    errors.length > 0 ? 'failing' : anyRunning ? 'pending' : 'passing';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 flex items-center gap-2">
          CI Checks
          {(() => {
            // Four-state header dot.
            //   loading / no data yet after click → amber pulse
            //   any check running                 → amber pulse
            //   any error                         → red solid
            //   all done + ok                     → green solid
            if (loading || anyRunning) {
              return <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" title={loading ? 'Waiting for first checks…' : 'Some checks still running'} />;
            }
            if (errors.length > 0) {
              return <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" title="CI failing" />;
            }
            if (checks.length > 0) {
              return <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" title="All checks finished — passing" />;
            }
            return null;
          })()}
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

      {checks.length === 0 && (
        <div className="text-xs text-zinc-500">
          {loading ? 'Waiting for first check results from the provider…' : 'No checks found.'}
        </div>
      )}

      {errors.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-wide text-red-400">Errors</div>
          {errors.map((c) => (
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

      {running.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5">
          <div className="text-[10px] uppercase tracking-wide text-amber-400">Running ({running.length})</div>
          {running.map((c) => (
            <div key={c.name} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
              <span className={c.status === 'in_progress' ? 'text-amber-400 animate-pulse' : 'text-amber-500'}>
                {c.status === 'in_progress' ? '▶' : '⋯'}
              </span>
              <span className="font-mono">{c.name}</span>
              <span className="ml-auto text-[10px] text-zinc-600">{c.status === 'in_progress' ? 'running' : c.status}</span>
            </div>
          ))}
        </div>
      )}

      {passed.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowPassed((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-emerald-400 hover:text-emerald-300"
          >
            {showPassed ? '▾' : '▸'} Passed ({passed.length})
          </button>
          {showPassed && (
            <div className="mt-0.5 flex flex-col gap-0.5">
              {passed.map((c) => (
                <div key={c.name} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
                  <span className="text-emerald-500">✓</span>
                  <span className="font-mono">{c.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {skipped.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowSkipped((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-400"
          >
            {showSkipped ? '▾' : '▸'} Skipped ({skipped.length})
          </button>
          {showSkipped && (
            <div className="mt-0.5 flex flex-col gap-0.5">
              {skipped.map((c) => (
                <div key={c.name} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-600">
                  <span className="text-zinc-600">⊘</span>
                  <span className="font-mono">{c.name}</span>
                  <span className="ml-auto text-[10px] text-zinc-700">{c.conclusion ?? 'n/a'}</span>
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
  if (rollup === 'passing') return <span className="text-xs text-emerald-400">✓ All checks passing</span>;
  if (rollup === 'failing') return <span className="text-xs text-red-400">✗ CI failing</span>;
  return <span className="text-xs text-amber-400">{anyRunning ? '▶ Running' : '⋯ Pending'}</span>;
}
