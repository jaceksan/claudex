# Non-voting CI checks — design

**Status:** approved 2026-04-19.
**Scope:** Plan 4, piece 1 of 4 (non-voting → flaky detection → conflicts → inbox).

## Problem

GitHub's branch protection decides which check names gate merge. Some teams
have checks that are branch-protection-required but **known-flaky** or
**slow-and-unreliable** — users want to stop letting them block their Merge
button without editing branch protection (which usually requires repo-admin
rights and affects everyone).

Today the CI panel sorts checks into "Required" vs "Advisory" based on the
adapter's `getRequiredChecks()`. There is no way for the user to say "treat
`lint-experimental` as advisory for me".

## Non-goals

- No flakiness *detection* (that's piece 2 of Plan 4).
- No edits to GitHub branch protection — this is a local claudex-side
  override only.
- No history of past suppressions.
- No dedicated settings page (may come later; pure additive UI).

## Decisions

| Question                  | Choice                                         |
|---------------------------|------------------------------------------------|
| Scope                     | **Per-repo** only                              |
| UX surface                | **Inline in CI panel** (one-click from failing row + collapsible "Suppressed" group for management) |
| How merge gate treats it  | **Third "Suppressed" group.** Rollup + `allRequiredGreen` filter them out. Stays visible so the user knows what's being ignored. |

## Data model

New table:

```sql
CREATE TABLE repo_nonvoting_check (
  repo_id        TEXT NOT NULL,
  check_name     TEXT NOT NULL,
  reason         TEXT,
  suppressed_at  INTEGER NOT NULL,
  PRIMARY KEY (repo_id, check_name),
  FOREIGN KEY (repo_id) REFERENCES repo(id) ON DELETE CASCADE
);
```

No history: unsuppressing deletes the row.

`RepoStore` gains:

- `listNonVoting(repoId): string[]`
- `addNonVoting(repoId, checkName, reason?): void`
- `removeNonVoting(repoId, checkName): void`

## Server flow

`TopicDetailBundle` gains `nonVotingChecks: string[]` populated from
`RepoStore.listNonVoting(topic.repoId)` in `buildTopicDetail`.

Two existing rollup sites consume it by **filtering the required set** before
their existing logic:

- `src/server/pr-lifecycle.ts::ciRollup` — drops suppressed names from
  `required` so a failing-but-suppressed check does not flip rollup to
  `failed`. If every remaining required check is green, rollup is `ok`.
- `src/web/components/action-bar.tsx::visibleActions` — same filter applied
  to `required` before computing `allRequiredGreen` / `hasFailingRequired`.

Both sites work off the same `nonVotingChecks` list passed through the
bundle, so client and server agree without re-fetching.

## WS envelope

New client → server messages:

- `client.repo.suppressCheck` — `{ repoId: string; checkName: string; reason?: string }`
- `client.repo.unsuppressCheck` — `{ repoId: string; checkName: string }`

Hub handler writes to `RepoStore`, then re-broadcasts fresh topic detail
**for every topic in that repo** (iterate `topics.listByRepo(repoId)` and
call `hub.refreshTopicDetail` for each). The repo scope means one
suppression can affect many topics — the broadcast keeps every open
topic page in sync.

Errors surface via the existing `server.topic.error` channel with `ctx:
'suppress'` / `'unsuppress'` so the topic page's error banner works.

## UI — CI panel

Three check groupings, in order:

1. **Required** — unchanged.
2. **⊘ Suppressed (N)** — new collapsible group (collapsed by default,
   auto-expanded when N > 0 and rollup is pending/failing so the user is
   reminded why). Each row: muted check name, `restore` button that fires
   `client.repo.unsuppressCheck`.
3. **Advisory (N)** — unchanged (collapsible, sorted as of prior commit).

Each **failing required** row gets a small `⊘` button next to the existing
`Fix` button. Clicking opens a lightweight modal:

> Stop gating merge on `<check-name>` for **this repo**?
> Optional reason: `[ _________ ]`
> [Cancel] [Suppress]

Submit fires `client.repo.suppressCheck`. No per-topic scope toggle in the
modal — scope is repo-wide by design.

Rollup badge and watch toggle are unchanged.

## Merge gate

`action-bar.tsx`'s `allRequiredGreen` computation becomes:

```ts
const effectiveRequired = (required ?? []).filter(
  (name) => !nonVotingChecks.includes(name)
);
const allRequiredGreen = effectiveRequired.length > 0 &&
  (checks ?? [])
    .filter((c) => effectiveRequired.includes(c.name))
    .every((c) => c.conclusion === 'success');
```

`hasFailingRequired` mirrors the filter. The Merge button's disabled
reason ("Needs approval / CI" vs "Resolve conflicts first") is unchanged.

## Edge cases

- **Branch protection later stops requiring a check that was suppressed.**
  Harmless: the row stays in the `repo_nonvoting_check` table but never
  matches a required check again, so it's a dead entry. User can still
  clean it up from the Suppressed group.
- **Suppression list grows large.** Not scoped — if it becomes a problem,
  add a settings page (additive UI, same table).
- **Two topics on the same repo viewed simultaneously after suppress.**
  Both get fresh `server.topic.detail` via the broadcast loop, so both
  panels flip at once.
- **FK cascade.** `ON DELETE CASCADE` on `repo_id` means removing a repo
  wipes its suppressions automatically.

## Testing

- `tests/repo.test.ts` — add suppression list CRUD coverage.
- `tests/topic-detail.test.ts` — bundle includes `nonVotingChecks`.
- `tests/pr-lifecycle.test.ts` — `ciRollup` filters out suppressed names.
- Manual UI check: suppress a failing required check → Merge button flips
  green; restore → flips back.

## README update

Add a bullet under CI features summarising the per-repo suppression
mechanism, following the existing doc style.
