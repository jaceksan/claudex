# Worktree/Topic/Task — Plan 4: Conflicts + Flaky triage + Non-voting + Inbox

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-04-17-worktree-topic-task-ux-design.md`
**Depends on:** Plans 1–3.

**Goal:** Stuck-PR scenarios become one-click: Sync with main with AI-driven narrative conflict resolution; flaky-CI triage with auto-restart; non-voting-check handling. Dashboard gets a Review Inbox tile.

**Architecture:** Conflicts are resolved inside a new `rebase` task whose output is parsed for an `## Uncertainties` block. Validation runs in the same task after resolution. UI surfaces only Summary + Uncertainties + Validation + Code drill-down. Flaky detection lives in `ci-triage.ts` and parses a structured `## Triage` block from the Fix-CI task's first message. Non-voting uses `Repo.requiredChecksCache` from Plan 1 + glob-based overrides.

---

## File Structure

**New:**
- `src/server/conflict.ts` — `startSync(topicId)`; parse `## Uncertainties` + `## Summary`.
- `src/server/ci-triage.ts` — classify failures; auto-rerun flakies; update `repo.flaky_patterns`.
- `src/server/non-voting.ts` — `isNonVoting(check, required, overrides)`; `refreshRequiredChecks(repoId)`.
- `src/server/handoff.ts` — lock topic, post PR comment or clipboard text.
- `src/server/inbox.ts` — compute inbox rows across topics.
- `src/web/components/conflict-review.tsx` — summary/uncertainties/validation/code tabs.
- `src/web/components/handoff-modal.tsx`.
- `src/web/components/review-inbox.tsx`.
- `tests/conflict.test.ts`, `tests/ci-triage.test.ts`, `tests/non-voting.test.ts`, `tests/inbox.test.ts`.

**Modify:**
- `src/server/pr-lifecycle.ts` — `syncWithMain`, `merge`.
- `src/server/topic-manager.ts` — spawn `rebase` task via `addRebaseTask`.
- `src/web/components/ci-panel.tsx` — collapse non-voting; `Restart anyway` buttons; flaky badges.
- `src/web/pages/dashboard.tsx` — Review Inbox at top.
- `src/server/ws/topic-envelope.ts` — handoff + conflict-review envelopes.

---

## Task 1: Non-voting classification

**Files:** Create `src/server/non-voting.ts`; test.

- [ ] **Step 1:** Test — matcher handles globs and force-required/advisory overrides.

```ts
import { describe, it, expect } from 'vitest';
import { isNonVoting } from '../src/server/non-voting';

describe('isNonVoting', () => {
  it('check in required set is voting', () => {
    expect(isNonVoting('build', ['build','test'], [])).toBe(false);
  });
  it('check not in required is non-voting', () => {
    expect(isNonVoting('sonar', ['build'], [])).toBe(true);
  });
  it('override glob forces advisory even when required', () => {
    expect(isNonVoting('sonar/quality', ['sonar/quality'], ['sonar/*'])).toBe(true);
  });
  it('empty required + empty overrides = all voting (safe default)', () => {
    expect(isNonVoting('x', [], [])).toBe(false);
  });
});
```

- [ ] **Step 2:** Implement:

```ts
import { minimatch } from 'minimatch';

export function isNonVoting(checkName: string, required: string[], overrides: string[]): boolean {
  if (overrides.some((pattern) => minimatch(checkName, pattern))) return true;
  if (required.length === 0) return false;
  return !required.includes(checkName);
}
```

- [ ] **Step 3:** Add `minimatch` to dependencies if not present. Commit:
```bash
npm install minimatch
CLAUDEX_SKIP_README=1 git commit -am "feat(ci): isNonVoting with glob overrides"
```

---

## Task 2: Required-checks refresh & cache

**Files:** Create `src/server/required-checks.ts`; test.

- [ ] **Step 1:** Test — `refreshRequiredChecks` calls adapter when cache stale or missing; uses cache when fresh.

- [ ] **Step 2:** Implement:

```ts
import type { RepoStore } from './repo';
import type { VcsAdapter } from './vcs/adapter';

const ONE_HOUR = 3600_000;

export async function getRequiredChecks(repos: RepoStore, adapter: VcsAdapter, repoId: string, maxAgeMs = ONE_HOUR): Promise<string[]> {
  const r = repos.getById(repoId); if (!r) throw new Error('repo not found');
  if (r.requiredChecksCache && r.requiredChecksCacheAt && Date.now() - r.requiredChecksCacheAt < maxAgeMs) {
    return r.requiredChecksCache;
  }
  const fetched = await adapter.getRequiredChecks(r.path, r.defaultBranch).catch(() => [] as string[]);
  repos.setRequiredChecksCache(repoId, fetched);
  return fetched;
}
```

- [ ] **Step 3:** Wire into `PrCache.get` so the bundle includes `requiredContexts` using this helper (replace the direct adapter call from Plan 3 Task 1).

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(ci): cache required-checks per repo with 1h TTL"
```

---

## Task 3: CI panel non-voting rendering

**Files:** Modify `src/web/components/ci-panel.tsx`.

- [ ] **Step 1:** Split `checks` into `{ required, nonVoting }` using `isNonVoting`.

- [ ] **Step 2:** Rollup header computed from required only.

- [ ] **Step 3:** Non-voting list collapsed under `▸ N advisory check(s)`; each rendered with muted text + `ⓘ advisory` pill.

- [ ] **Step 4:** Required failures have `Fix` button (dispatches `client.topic.fixCheck`).

- [ ] **Step 5:** `Restart anyway` next to every failing check (regardless of voting) — dispatches `client.pr.rerunCheck`.

- [ ] **Step 6:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(ci-panel): non-voting collapse + Restart buttons"
```

---

## Task 4: Flaky triage

**Files:** Create `src/server/ci-triage.ts`; test.

- [ ] **Step 1:** Test — parses a structured triage block:

```ts
import { describe, it, expect } from 'vitest';
import { parseTriage, applyTriage } from '../src/server/ci-triage';

const TEXT = `
## Triage
- build:                code-issue
- test-kotlin-calcique: flaky-infra     (reason: "Connection refused")
- lint-kotlin:          code-issue
`;

describe('parseTriage', () => {
  it('parses lines', () => {
    const parsed = parseTriage(TEXT);
    expect(parsed).toEqual([
      { name: 'build', verdict: 'code-issue', reason: null },
      { name: 'test-kotlin-calcique', verdict: 'flaky-infra', reason: 'Connection refused' },
      { name: 'lint-kotlin', verdict: 'code-issue', reason: null },
    ]);
  });
  it('returns empty when block missing', () => {
    expect(parseTriage('no block here')).toEqual([]);
  });
});
```

- [ ] **Step 2:** Implement parser:

```ts
export interface TriageEntry { name: string; verdict: 'code-issue' | 'flaky-infra' | 'flaky-test' | 'unknown'; reason: string | null; }

export function parseTriage(text: string): TriageEntry[] {
  const start = text.indexOf('## Triage');
  if (start < 0) return [];
  const slice = text.slice(start).split('\n## ')[0];
  const lines = slice.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  const out: TriageEntry[] = [];
  for (const line of lines) {
    const m = /^- (\S+?):\s+(code-issue|flaky-infra|flaky-test|unknown)(?:\s+\(reason:\s*"([^"]*)"\))?/.exec(line);
    if (m) out.push({ name: m[1], verdict: m[2] as TriageEntry['verdict'], reason: m[3] ?? null });
  }
  return out;
}
```

- [ ] **Step 3:** `applyTriage(triage, adapter, cwd, checks)` — for each `flaky-*`, call `adapter.rerunFailedChecks(cwd, runId)`; for each `code-issue`, return for fix-path. Max 2 auto-restarts per check per PR (counter persisted per `topic`).

- [ ] **Step 4:** Wire into Fix-CI task completion: before spawning a code-fixing session, run a quick triage sub-step (either part of the same Claude prompt or a first-pass reading of logs). Simpler MVP: include a `## Triage` request at the top of the Fix-CI prompt; parse the task's final message when it arrives.

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(ci-triage): parse Triage block and auto-rerun flakies"
```

---

## Task 5: Sync with main — happy path

**Files:** Extend `src/server/pr-lifecycle.ts`, `src/server/topic-manager.ts`; create `src/server/conflict.ts`.

- [ ] **Step 1:** `PrLifecycle.syncWithMain(topicId)`:
  1. `git fetch canonical_remote default_branch` in repo path.
  2. Try a clean rebase inside a fresh rebase worktree (cut off topic branch tip).
  3. If clean → `git push --force-with-lease fork_remote topic_branch`; invalidate PR cache; done.
  4. If conflict → spawn a `rebase` task via `TopicManager.addRebaseTask` with the seeded prompt (spec §9.1).

- [ ] **Step 2:** `TopicManager.addRebaseTask(topicId, args)`:
  - `type=rebase`
  - permission `acceptEdits`, effort `high`
  - scoped `--allowedTools` to Read/Edit on conflicted files + `repo.validateCmd` invocation
  - initial prompt includes list of conflicted files + template from §9.1.

- [ ] **Step 3:** `conflict.ts`:

```ts
export interface ParsedConflictReport {
  summary: string;
  uncertainties: Uncertainty[];
  validation: { passed: boolean; tail: string | null };
}
export interface Uncertainty { title: string; mainSide: string; topicSide: string; reason: string; chose: string; alternatives: string[]; }

export function parseConflictReport(text: string): ParsedConflictReport {
  const summary = extractSection(text, '## Summary') ?? '';
  const unc = extractSection(text, '## Uncertainties');
  const uncertainties: Uncertainty[] = [];
  if (unc && !/^\s*\(?none\)?\s*$/i.test(unc)) {
    const cards = unc.split(/^### /m).slice(1);
    for (const c of cards) uncertainties.push(parseCard(c));
  }
  const val = extractSection(text, '## Validation');
  const passed = !val || /passed|green|success/i.test(val);
  return { summary, uncertainties, validation: { passed, tail: val } };
}

function extractSection(s: string, heading: string): string | null {
  const start = s.indexOf(heading);
  if (start < 0) return null;
  const after = s.slice(start + heading.length);
  const next = after.search(/\n## /);
  return (next < 0 ? after : after.slice(0, next)).trim();
}

function parseCard(block: string): Uncertainty {
  const lines = block.split('\n');
  const title = lines[0].trim();
  const field = (label: string): string => {
    const m = new RegExp(`^- ${label}:\\s*(.+)$`, 'mi').exec(block);
    return m ? m[1].trim() : '';
  };
  const alts = [...block.matchAll(/^- Alternative:\s*(.+)$/gmi)].map((m) => m[1].trim());
  return {
    title,
    mainSide: field('Main') || field('Their side'),
    topicSide: field('Topic') || field('Your side'),
    reason: field('Tension') || field('Why I wasn\'t sure'),
    chose: field('I chose') || field('Chose'),
    alternatives: alts,
  };
}
```

- [ ] **Step 4:** Tests for clean-rebase happy path (no task spawned) and for conflict path (task spawned, report parsed).

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(sync): clean-rebase push + rebase task + conflict report parse"
```

---

## Task 6: Conflict review UI

**Files:** Create `src/web/components/conflict-review.tsx`; wire into topic detail.

- [ ] **Step 1:** Component props `{ report: ParsedConflictReport; onAcceptResolution: () => void; onReject: (hint?: string) => void; onHandoff: () => void; }`.

- [ ] **Step 2:** Sections in order:
  - Summary (always expanded).
  - Uncertainties (expanded if present; each a card with `Looks good / Use main / Use mine / Let me edit`).
  - Validation (expanded if failed; with `Fix it` → spawns fix task scoped to the failure).
  - Code (collapsed; clicking expands to a simple file list + two-pane diff via existing Edit view).
  - Action row: `Accept resolution`, `Reject and try again`, `Hand off to a developer`.

- [ ] **Step 3:** Accept resolution dispatches `client.topic.acceptRebase` → backend `git rebase --continue` in the rebase worktree, then force-with-lease push.

- [ ] **Step 4:** Reject dispatches `client.topic.retryRebase` with optional hint text seeded into the new task's prompt.

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(conflict): narrative review UI"
```

---

## Task 7: Handoff flow

**Files:** Create `src/server/handoff.ts`, `src/web/components/handoff-modal.tsx`; modify topic envelope and `conflict-review.tsx`.

- [ ] **Step 1:** `handoff.ts`:

```ts
export async function handOff(deps: { topics: TopicStore; repos: RepoStore; adapter: VcsAdapter; git: Git }, args: {
  topicId: string; recipient: string; note: string;
}) {
  const topic = deps.topics.getById(args.topicId)!; const repo = deps.repos.getById(topic.repoId)!;
  deps.topics.setBlockedOnHuman(args.topicId, true);
  // Push draft rebase branch so the developer can inspect.
  const draftBranch = `${topic.topicBranch}__rebase-draft-${Date.now()}`;
  await deps.git(['branch', draftBranch, topic.topicBranch!], repo.path);
  await deps.git(['push', repo.forkRemote, draftBranch], repo.path);
  if (topic.prNumber) {
    const body = `@${args.recipient} — conflict sync needs your eyes. Branch: \`${topic.topicBranch}\`. Draft resolution on \`${draftBranch}\`. ${args.note}`;
    await deps.adapter.replyOnThread(repo.path, ''/*nope — we need a PR-level comment API*/, body).catch(() => {/* fallback */});
    // Actual API: gh pr comment <n> --body "..." — add this to VcsAdapter in Task 7.5.
  }
}
```

- [ ] **Step 2:** Add `VcsAdapter.postPRComment(cwd, number, body): Promise<void>` to the interface (Plan 1 defines the interface; this is a small extension — update `vcs/adapter.ts`, `vcs/github.ts`, and this plan's `handoff.ts`).

- [ ] **Step 3:** `HandoffModal` — list collaborators (via `VcsAdapter.listCollaborators`), select one, optional note, `Send` button. Show clipboard-copy fallback text if no PR yet.

- [ ] **Step 4:** `I'm back` button on topic-detail page when `topic.blockedOnHuman` — clears lock, triggers a refresh.

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(handoff): lock topic + post PR comment + draft branch push"
```

---

## Task 8: Merge button + branch protection reality

**Files:** Extend `src/server/pr-lifecycle.ts`; modify ActionBar.

- [ ] **Step 1:** `PrLifecycle.merge(topicId)`:
  - Verify (via cached PR bundle) `mergeable=true`, required checks pass, no conflicts.
  - Call `adapter.mergePR(cwd, prNumber, repo.mergeStrategy)`.
  - On success: phase → Merged; GC worktrees + local child branches; remote topic branch deleted by `--delete-branch`.

- [ ] **Step 2:** If GitHub returns 405 "not mergeable" (protections), surface the exact API error text in a toast (OS notification + inline message), don't silently fail.

- [ ] **Step 3:** ActionBar merge button: disabled with tooltip `Waiting for approval / CI` derived from bundle. Enabled only when green + mergeable.

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(merge): merge with strategy + GC on success"
```

---

## Task 9: Review Inbox

**Files:** Create `src/server/inbox.ts`, `src/web/components/review-inbox.tsx`; modify `src/web/pages/dashboard.tsx`.

- [ ] **Step 1:** `inbox.ts` computes an actionable list across repos:

```ts
export interface InboxRow { topicId: string; title: string; kind: 'ci-failing' | 'comments' | 'rebase' | 'ready-to-merge' | 'handoff-received'; detail: string; actionLabel: string; }

export async function computeInbox(deps: { topics: TopicStore; repos: RepoStore; prCache: PrCache }): Promise<InboxRow[]> {
  const rows: InboxRow[] = [];
  for (const repo of deps.repos.list()) {
    for (const topic of deps.topics.listByRepo(repo.id)) {
      if (topic.phase !== 'Open' || !topic.prNumber) continue;
      const b = await deps.prCache.get(repo.path, topic.prNumber, repo.defaultBranch).catch(() => null);
      if (!b) continue;
      const requiredFailing = b.checks.filter((c) => c.conclusion === 'failure' && b.requiredContexts.includes(c.name));
      if (requiredFailing.length) rows.push({ topicId: topic.id, title: topic.title, kind: 'ci-failing', detail: `${requiredFailing.length} required failing`, actionLabel: 'Fix all' });
      const unresolvedHuman = b.threads.filter((t) => !t.isResolved && t.comments.some((c) => !c.isBot));
      if (unresolvedHuman.length) rows.push({ topicId: topic.id, title: topic.title, kind: 'comments', detail: `${unresolvedHuman.length} comments`, actionLabel: 'Address' });
      if (b.pr.mergeable === false) rows.push({ topicId: topic.id, title: topic.title, kind: 'rebase', detail: 'Rebase needed', actionLabel: 'Sync' });
      else if (b.pr.approvalsCount >= b.pr.requiredApprovals && requiredFailing.length === 0) rows.push({ topicId: topic.id, title: topic.title, kind: 'ready-to-merge', detail: 'Approved, CI green', actionLabel: 'Merge' });
    }
  }
  return rows;
}
```

- [ ] **Step 2:** Server exposes `GET /api/inbox` returning rows.

- [ ] **Step 3:** `ReviewInbox` component — table with kind-based icon, click-through to topic page with the right panel focused (via query-string like `?focus=ci`).

- [ ] **Step 4:** Dashboard pulls the inbox; hidden entirely when empty (with a preference toggle).

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(inbox): Review Inbox tile aggregating actionable signals"
```

---

## Task 10: Smoke + README

- [ ] **Step 1:** Manual flow:
  - Intentionally dirty a topic branch so rebase onto main conflicts; click Sync with main; verify rebase task spawns, Claude produces report, Accept resolution pushes.
  - Introduce a flaky failure by renaming a test temporarily; click Fix all; verify triage classifies as flaky and `gh run rerun --failed` is called (or failing, that a code fix is spawned).
  - Verify non-voting Sonar-style failure doesn't turn rollup red and doesn't appear in Inbox.

- [ ] **Step 2:** Run full verification suite.

- [ ] **Step 3:** README update: bullets for Conflict resolution with narrative review, Flaky triage, Non-voting checks, Review Inbox, Handoff.

- [ ] **Step 4:** Commit README.

---

## Plan 4 done when

- Sync with main handles clean + conflicting rebases; conflict task produces Summary/Uncertainties/Validation.
- Conflict review UI renders narrative first; accept/reject/handoff buttons work.
- Flaky triage auto-reruns without spawning code fixes.
- Non-voting checks never block merge or turn rollup red.
- Review Inbox lists actionable items across topics and click-through focuses the right panel.
- Handoff locks the topic and pushes a draft branch.
