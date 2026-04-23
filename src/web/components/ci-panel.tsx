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
  nonVotingChecks = [],
  flakyChecks = [],
  onFix,
  pendingFixes,
  onWatchToggle,
  onRefresh,
  onSuppress,
  onUnsuppress,
  onRetry,
}: {
  checks: Check[];
  /** Unused; kept in the props for future "mark non-voting" work. */
  required?: string[];
  /** Check names suppressed for this repo — rendered in a dedicated group, kept out of Errors. */
  nonVotingChecks?: string[];
  /** Check names classified as flaky (mixed pass/fail in recent history). Rendered with a tag on Errors rows. */
  flakyChecks?: string[];
  watchEnabled: boolean;
  loading?: boolean;
  onFix: (checkName: string) => void;
  /** Set of keys like `check:<name>` indicating a Fix click is in-flight. */
  pendingFixes?: Set<string>;
  onWatchToggle: (enable: boolean) => void;
  onRefresh?: () => void;
  onSuppress?: (checkName: string, reason?: string) => void;
  onUnsuppress?: (checkName: string) => void;
  onRetry?: (checkName: string) => void;
}) {
  const flakySet = new Set(flakyChecks);
  const [showPassed, setShowPassed] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showSuppressed, setShowSuppressed] = useState(true);

  const suppressedSet = new Set(nonVotingChecks);
  const sorted = checks.slice().sort((a, b) => a.name.localeCompare(b.name));
  const suppressed = sorted.filter((c) => suppressedSet.has(c.name));
  const active = sorted.filter((c) => !suppressedSet.has(c.name));
  const errors = active.filter((c) => bucketOf(c) === 'errors');
  const running = active.filter((c) => bucketOf(c) === 'running');
  const passed = active.filter((c) => bucketOf(c) === 'passed');
  const skipped = active.filter((c) => bucketOf(c) === 'skipped');

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
          {errors.map((c) => {
            const isFlaky = flakySet.has(c.name);
            return (
              <div key={c.name} className="flex items-center justify-between rounded border border-red-900/40 bg-red-950/20 px-2 py-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-red-400">✗</span>
                  <span className="truncate text-xs text-zinc-300 font-mono" title={c.name}>{c.name}</span>
                  {isFlaky && (
                    <span
                      className="shrink-0 rounded bg-amber-900/40 px-1.5 py-0 text-[10px] uppercase tracking-wide text-amber-300"
                      title="Mixed pass/fail in recent runs — probably flaky. Try Retry before Fix."
                    >
                      flaky
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onFix(c.name)}
                    disabled={pendingFixes?.has(`check:${c.name}`) ?? false}
                    className="rounded bg-red-800 px-2 py-0.5 text-xs text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-900/60 disabled:text-red-200/80"
                    title={pendingFixes?.has(`check:${c.name}`) ? 'Fix task is being created…' : undefined}
                  >
                    {pendingFixes?.has(`check:${c.name}`) ? 'Starting…' : 'Fix'}
                  </button>
                  {onRetry && c.runId !== undefined && c.runId !== null && (
                    <button
                      type="button"
                      onClick={() => onRetry(c.name)}
                      className={`rounded border px-2 py-0.5 text-xs ${
                        isFlaky
                          ? 'border-amber-600 text-amber-300 hover:border-amber-500 hover:text-amber-200'
                          : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                      }`}
                      title="Rerun the failed jobs in this workflow run — cheap first step for flaky infra"
                    >
                      ↻ Retry
                    </button>
                  )}
                  {onSuppress && (
                    <button
                      type="button"
                      onClick={() => {
                        const reason = window.prompt(`Stop gating merge on "${c.name}" for this repo?\nOptional reason (for your own records):`, '');
                        if (reason !== null) onSuppress(c.name, reason.trim() || undefined);
                      }}
                      className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                      title="Mark this check non-voting — stays visible but no longer shows as an error"
                    >
                      ⊘ Suppress
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {suppressed.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowSuppressed((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
          >
            {showSuppressed ? '▾' : '▸'} Suppressed ({suppressed.length})
          </button>
          {showSuppressed && (
            <div className="mt-0.5 flex flex-col gap-0.5">
              {suppressed.map((c) => (
                <div key={c.name} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
                  <span className="text-zinc-500">⊘</span>
                  <span className="truncate font-mono" title={c.name}>{c.name}</span>
                  <span className="ml-auto text-[10px] text-zinc-600">non-voting</span>
                  {onUnsuppress && (
                    <button
                      type="button"
                      onClick={() => onUnsuppress(c.name)}
                      className="rounded border border-zinc-700 px-1.5 py-0 text-[10px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                      title="Restore as a normal check"
                    >
                      restore
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
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
