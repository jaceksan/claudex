import type Database from 'better-sqlite3';

/**
 * Local history of CI check outcomes per repo. Populated from PrLifecycle's
 * poll ticks so we can classify a check as "flaky" (mixed pass/fail in
 * recent history) without hitting the gh API every render.
 */

const HISTORY_CAP_PER_CHECK = 50;   // keep at most 50 samples per (repo, check name)
const FLAKY_WINDOW = 10;            // look back this many samples to decide flakiness

export interface CheckSample {
  conclusion: string;      // success / failure / timed_out / skipped / cancelled / neutral
  observedAt: number;
  prNumber: number;
  runId: number;
}

export class CiHistoryStore {
  constructor(private db: Database.Database) {}

  /**
   * Upsert a completed check observation. No-op for checks that haven't
   * finished yet (we only record completed states so the flaky classifier
   * isn't confused by in-flight runs). Prunes older rows past the per-check
   * cap to keep table size bounded without a separate janitor.
   */
  record(repoId: string, checkName: string, prNumber: number, runId: number | null, conclusion: string | null): void {
    if (!conclusion) return;
    const rid = runId ?? 0;
    this.db.prepare(`
      INSERT INTO ci_check_history (repo_id, check_name, pr_number, run_id, conclusion, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, check_name, pr_number, run_id)
      DO UPDATE SET conclusion=excluded.conclusion, observed_at=excluded.observed_at
    `).run(repoId, checkName, prNumber, rid, conclusion, Date.now());

    // Trim oldest rows for this (repo, check_name) if we've exceeded the cap.
    // Use a CTE-style rowid filter rather than ORDER BY + LIMIT so the delete
    // plays nicely across SQLite versions.
    this.db.prepare(`
      DELETE FROM ci_check_history
      WHERE repo_id=? AND check_name=?
      AND rowid NOT IN (
        SELECT rowid FROM ci_check_history
        WHERE repo_id=? AND check_name=?
        ORDER BY observed_at DESC, rowid DESC LIMIT ?
      )
    `).run(repoId, checkName, repoId, checkName, HISTORY_CAP_PER_CHECK);
  }

  /**
   * Most-recent-first samples for one check. Rowid is the tiebreaker so that
   * records inserted within the same millisecond keep their insertion order.
   */
  recentSamples(repoId: string, checkName: string, limit = FLAKY_WINDOW): CheckSample[] {
    const rows = this.db.prepare(`
      SELECT conclusion, observed_at, pr_number, run_id
      FROM ci_check_history
      WHERE repo_id=? AND check_name=?
      ORDER BY observed_at DESC, rowid DESC
      LIMIT ?
    `).all(repoId, checkName, limit) as Array<{ conclusion: string; observed_at: number; pr_number: number; run_id: number }>;
    return rows.map((r) => ({ conclusion: r.conclusion, observedAt: r.observed_at, prNumber: r.pr_number, runId: r.run_id }));
  }

  /**
   * Set of check names that look flaky in this repo: within the last
   * FLAKY_WINDOW observations, at least one `success` AND at least one
   * `failure`/`timed_out`. Skipped/cancelled/neutral don't contribute.
   */
  flakyChecksForRepo(repoId: string): string[] {
    const names = (this.db.prepare('SELECT DISTINCT check_name FROM ci_check_history WHERE repo_id=?')
      .all(repoId) as Array<{ check_name: string }>).map((r) => r.check_name);
    const flaky: string[] = [];
    for (const name of names) {
      if (isFlaky(this.recentSamples(repoId, name))) flaky.push(name);
    }
    return flaky.sort();
  }
}

export function isFlaky(samples: CheckSample[]): boolean {
  let sawPass = false;
  let sawFail = false;
  for (const s of samples.slice(0, FLAKY_WINDOW)) {
    if (s.conclusion === 'success') sawPass = true;
    else if (s.conclusion === 'failure' || s.conclusion === 'timed_out') sawFail = true;
    if (sawPass && sawFail) return true;
  }
  return false;
}
