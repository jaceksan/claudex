# Flaky CI detection + retry — design

**Status:** implemented 2026-04-21.
**Scope:** Plan 4, piece 2 of 4 (non-voting ✓ → flaky → conflicts → inbox).

## Problem

A CI check that fails *intermittently* is usually not a code problem — it's
flaky infrastructure, a race, a rate-limited external API, etc. The right
response is "retry", not "spawn a fix-ci task and ask Claude to patch code
that isn't broken". Today the panel can't tell the two apart.

## Scope

1. **Track** every completed check result we observe, per repo.
2. **Classify** a check as flaky when its recent history mixes success and
   failure.
3. **Surface** the flaky tag on failing rows in the CI panel.
4. **Retry** action — `gh run rerun <runId>` — wired to a Retry button next
   to Fix.

Explicit non-goals for this slice: auto-retry, cross-branch aggregation,
flakiness scoring, hiding flakies from rollup. A flaky check still counts
as a failure until it reruns green; we just label it and give the user a
cheaper action than Fix.

## Data

```sql
CREATE TABLE ci_check_history (
  repo_id      TEXT NOT NULL,
  check_name   TEXT NOT NULL,
  pr_number    INTEGER NOT NULL,
  run_id       INTEGER NOT NULL DEFAULT 0,
  conclusion   TEXT NOT NULL,     -- success / failure / timed_out / skipped / cancelled / neutral
  observed_at  INTEGER NOT NULL,
  PRIMARY KEY (repo_id, check_name, pr_number, run_id),
  FOREIGN KEY (repo_id) REFERENCES repo(id) ON DELETE CASCADE
);
CREATE INDEX idx_cch_repo_name_observed ON ci_check_history(repo_id, check_name, observed_at DESC);
```

Written from `PrLifecycle._pollCi` on every tick: for each **completed**
check, upsert a row (replace-on-conflict because the same run_id may
report multiple times before closing). Skipped/cancelled/neutral still
get recorded so we know the check actually ran — they just don't count
toward success/failure ratios.

Retention: cap at 50 rows per `(repo_id, check_name)` by deleting the
oldest on every insert that would push past the limit. Keeps the table
bounded without a separate janitor.

## Classification

```ts
function isFlaky(samples: CheckSample[]): boolean {
  const recent = samples.slice(0, 10); // already ordered by observed_at desc
  let saw = { success: false, failure: false };
  for (const s of recent) {
    if (s.conclusion === 'success') saw.success = true;
    else if (s.conclusion === 'failure' || s.conclusion === 'timed_out') saw.failure = true;
    if (saw.success && saw.failure) return true;
  }
  return false;
}
```

Per-repo flaky set computed server-side in `buildTopicDetail`; delivered
as `TopicDetailBundle.flakyChecks: string[]`.

## Rerun

`VcsAdapter.rerunRun(cwd, runId, options?)` → `gh run rerun <runId> --failed`
(only reruns the failed jobs in that workflow run; cheaper than a full
rerun). GitLab adapter gets a stub.

New envelope message:

- `client.pr.rerunCheck` — `{ topicId: string; checkName: string }`

Hub handler: locate check in the current PR bundle, resolve `runId`, call
`adapter.rerunRun`, invalidate the PR cache entry so the next poll picks
up fresh state. Same error channel as Fix.

## UI

CI panel — errors rows gain a trailing row of small buttons in this order:

- `Fix` (existing, destructive-ish — spawns a fix-ci task session)
- `Retry` — visible only when `check.runId` is set (gh needs it)
- `⊘ Suppress` (existing)

Each error row's name line shows a small amber `flaky` tag when the
check name is in `flakyChecks`. This is the primary "don't spawn Fix,
just Retry" signal for non-tech users.

## Tests

- `tests/ci-history.test.ts` — recordCheckResult persists + prunes to
  last 50; flaky classification covers { no history, all pass, all
  fail, mixed, mixed-but-old, skipped-only }.
- `tests/pr-lifecycle.test.ts` — `_pollCi` writes to ci_check_history
  and deduplicates same run_id.
- `tests/topic-detail.test.ts` — flakyChecks surfaces in the bundle.
- `tests/vcs-github.test.ts` — rerunRun calls `gh run rerun` with the
  right arguments.
