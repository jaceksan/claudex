# Worktree/Topic/Task — Plan 6: GitLab adapter + polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-04-17-worktree-topic-task-ux-design.md`
**Depends on:** Plans 1–5.

**Goal:** GitLab-class repos (e.g., dag_bpay) work end-to-end through claudex. MR-vs-PR terminology surfaces only in power-user views; the main UI uses neutral verbs. README roadmap updated. Final migration cleanup.

**Architecture:** New `GitLabAdapter` over `glab` CLI and `glab api` GraphQL. Neutral-verb helper (`vcsLabels`) swaps concrete nouns in power-user surfaces. MR discussions map to `ReviewThread` via `resolved` flag and `notes` list.

---

## File Structure

**New:**
- `src/server/vcs/gitlab.ts` — `GitLabAdapter` implementing `VcsAdapter`.
- `src/server/vcs/labels.ts` — `vcsLabels(kind)` helper.
- `tests/vcs-gitlab.test.ts`, `tests/fixtures/glab-output/*.json`.

**Modify:**
- `src/server/vcs/index.ts` — factory returns `GitLabAdapter` when repo row has `vcs_kind='gitlab'`.
- `src/server/commands.ts` — repo registration detects GitLab (remote URL contains `gitlab`), auto-sets `vcs_kind`.
- `src/web/components/topic-header.tsx`, `.../ci-panel.tsx`, `.../action-bar.tsx` — use `vcsLabels` for power-user power strings (neutral verbs stay unchanged).
- `README.md` — roadmap updates.

---

## Task 1: `GitLabAdapter` — read-side

**Files:** Create `src/server/vcs/gitlab.ts`; `tests/vcs-gitlab.test.ts`; fixtures.

- [ ] **Step 1:** Collect fixture JSON (or hand-craft) for: `glab mr view`, `glab ci status`, `glab api /projects/:id/merge_requests/:n/discussions`, `glab api /projects/:id/protected_branches/<main>`.

`tests/fixtures/glab-output/mr-view.json`:
```json
{"iid":213,"web_url":"https://gitlab.example/acme/repo/-/merge_requests/213","title":"Fix payout retry","description":"...","state":"opened","source_branch":"feature/cbp/CBP-1234-payout-retry","target_branch":"master","author":{"username":"jaceksan"},"merge_status":"can_be_merged","approvals_before_merge":1,"approved_by":[]}
```

- [ ] **Step 2:** Test `getPR`:

```ts
import { describe, it, expect } from 'vitest';
import { GitLabAdapter } from '../src/server/vcs/gitlab';
import { readFileSync } from 'node:fs';

describe('GitLabAdapter.getPR', () => {
  it('parses glab mr view JSON as PR', async () => {
    const stub = readFileSync('tests/fixtures/glab-output/mr-view.json', 'utf8');
    const a = new GitLabAdapter({ exec: async () => stub });
    const pr = await a.getPR('/tmp/r', 213);
    expect(pr.number).toBe(213);
    expect(pr.state).toBe('OPEN');
    expect(pr.headBranch).toBe('feature/cbp/CBP-1234-payout-retry');
    expect(pr.baseBranch).toBe('master');
    expect(pr.mergeable).toBe(true);
  });
});
```

- [ ] **Step 3:** Implement read methods (`getCurrentUser`, `getRepo`, `getPR`, `listReviewThreads`, `listChecks`, `getRequiredChecks`, `listCollaborators`):

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VcsAdapter, PR, RepoSummary, ReviewThread, Check } from './adapter';

const exec = promisify(execFile);
export type Exec = (file: string, args: string[], opts?: { cwd?: string }) => Promise<string>;
const defaultExec: Exec = async (file, args, opts) => (await exec(file, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;

export class GitLabAdapter implements VcsAdapter {
  readonly kind = 'gitlab' as const;
  private exec: Exec;
  constructor(opts: { exec?: Exec } = {}) { this.exec = opts.exec ?? defaultExec; }

  private async glab(args: string[], cwd?: string): Promise<string> { return this.exec('glab', args, { cwd }); }

  async getCurrentUser() {
    const out = await this.glab(['api', 'user']);
    const j = JSON.parse(out);
    return { login: j.username };
  }

  async getRepo(cwd: string): Promise<RepoSummary> {
    const out = await this.glab(['repo', 'view', '--json'], cwd);
    const j = JSON.parse(out);
    return {
      owner: j.namespace?.path ?? j.owner?.username ?? '',
      name: j.path ?? j.name,
      defaultBranch: j.default_branch ?? 'main',
      parentOwner: j.forked_from_project?.namespace?.path,
      parentName: j.forked_from_project?.path,
    };
  }

  async getPR(cwd: string, n: number): Promise<PR> {
    const out = await this.glab(['mr', 'view', String(n), '--json'], cwd);
    const j = JSON.parse(out);
    const state = j.state === 'opened' ? 'OPEN' : j.state === 'merged' ? 'MERGED' : 'CLOSED';
    return {
      number: j.iid, url: j.web_url, title: j.title, body: j.description ?? '', state,
      baseBranch: j.target_branch, headBranch: j.source_branch,
      author: j.author?.username ?? '',
      mergeable: j.merge_status === 'can_be_merged' ? true : j.merge_status === 'cannot_be_merged' ? false : null,
      approvalsCount: (j.approved_by ?? []).length, requiredApprovals: j.approvals_before_merge ?? 0,
    };
  }

  async listReviewThreads(cwd: string, n: number): Promise<ReviewThread[]> {
    const repo = await this.getRepo(cwd);
    const projectId = `${repo.owner}/${repo.name}`.replace(/\//g, '%2F');
    const out = await this.glab(['api', `projects/${projectId}/merge_requests/${n}/discussions`, '--paginate'], cwd);
    const items = JSON.parse(out) as any[];
    return items.map((d) => ({
      id: d.id,
      isResolved: d.notes?.every((n: any) => n.resolvable ? n.resolved : true) ?? true,
      comments: (d.notes ?? []).filter((n: any) => !n.system).map((note: any) => ({
        author: note.author?.username ?? '', isBot: note.author?.state === 'bot', body: note.body,
        path: note.position?.new_path ?? null, line: note.position?.new_line ?? null,
      })),
    }));
  }

  async listChecks(cwd: string, ref: string): Promise<Check[]> {
    const repo = await this.getRepo(cwd);
    const projectId = `${repo.owner}/${repo.name}`.replace(/\//g, '%2F');
    const out = await this.glab(['api', `projects/${projectId}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`], cwd);
    const pipelines = JSON.parse(out) as any[];
    if (pipelines.length === 0) return [];
    const p = pipelines[0];
    const jobsOut = await this.glab(['api', `projects/${projectId}/pipelines/${p.id}/jobs`, '--paginate'], cwd);
    const jobs = JSON.parse(jobsOut) as any[];
    return jobs.map((j) => ({
      name: j.name,
      status: j.status === 'running' ? 'in_progress' : j.status === 'pending' ? 'queued' : 'completed',
      conclusion: j.status === 'success' ? 'success' : j.status === 'failed' ? 'failure' : j.status === 'canceled' ? 'cancelled' : null,
      runId: j.id, url: j.web_url,
      startedAt: j.started_at ? Date.parse(j.started_at) : null,
      completedAt: j.finished_at ? Date.parse(j.finished_at) : null,
    }));
  }

  async getRequiredChecks(cwd: string, branch: string): Promise<string[]> {
    const repo = await this.getRepo(cwd);
    const projectId = `${repo.owner}/${repo.name}`.replace(/\//g, '%2F');
    try {
      const out = await this.glab(['api', `projects/${projectId}/protected_branches/${encodeURIComponent(branch)}`], cwd);
      const j = JSON.parse(out);
      // GitLab does not enumerate required pipelines directly; use `allow_force_push`/`unprotect_access_levels` as heuristics.
      // For MVP, return project-level required pipeline names from project settings if available.
      return j.required_approval_rules?.map((r: any) => r.name) ?? [];
    } catch { return []; }
  }

  async listCollaborators(cwd: string): Promise<{ login: string; name?: string }[]> {
    const repo = await this.getRepo(cwd);
    const pid = `${repo.owner}/${repo.name}`.replace(/\//g, '%2F');
    const out = await this.glab(['api', `projects/${pid}/members/all`, '--paginate'], cwd);
    return (JSON.parse(out) as any[]).map((m) => ({ login: m.username, name: m.name }));
  }

  // Write-side stubs filled in Task 2
  async createPR(): Promise<PR> { throw new Error('implemented in Task 2'); }
  async mergePR(): Promise<void> { throw new Error('implemented in Task 2'); }
  async replyOnThread(): Promise<void> { throw new Error('implemented in Task 2'); }
  async resolveThread(): Promise<void> { throw new Error('implemented in Task 2'); }
  async rerunFailedChecks(): Promise<void> { throw new Error('implemented in Task 2'); }
}
```

- [ ] **Step 4:** Tests for each read method with fixtures. Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(vcs-gitlab): GitLabAdapter read-side (getPR/threads/checks/collab)"
```

---

## Task 2: `GitLabAdapter` — write-side

**Files:** Extend `src/server/vcs/gitlab.ts`.

- [ ] **Step 1:** Implement:

```ts
async createPR(input: { cwd: string; base: string; head: string; title: string; body: string }): Promise<PR> {
  const out = await this.glab(['mr', 'create', '--target-branch', input.base, '--source-branch', input.head,
    '--title', input.title, '--description', input.body, '--yes', '--json'], input.cwd);
  const j = JSON.parse(out);
  return this.getPR(input.cwd, j.iid);
}

async mergePR(cwd: string, n: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void> {
  const args = ['mr', 'merge', String(n), '--yes', '--remove-source-branch'];
  if (strategy === 'squash') args.push('--squash');
  await this.glab(args, cwd);
}

async replyOnThread(cwd: string, threadId: string, body: string): Promise<void> {
  const repo = await this.getRepo(cwd); const pid = `${repo.owner}/${repo.name}`.replace(/\//g, '%2F');
  // threadId encodes "mr_iid:discussion_id" — callers must package both. Keep the adapter symmetric.
  const [mrIid, discussionId] = threadId.split(':');
  await this.glab(['api', '--method', 'POST',
    `projects/${pid}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
    '-f', `body=${body}`], cwd);
}

async resolveThread(cwd: string, threadId: string): Promise<void> {
  const repo = await this.getRepo(cwd); const pid = `${repo.owner}/${repo.name}`.replace(/\//g, '%2F');
  const [mrIid, discussionId] = threadId.split(':');
  await this.glab(['api', '--method', 'PUT',
    `projects/${pid}/merge_requests/${mrIid}/discussions/${discussionId}`,
    '-f', 'resolved=true'], cwd);
}

async rerunFailedChecks(cwd: string, runId: number): Promise<void> {
  const repo = await this.getRepo(cwd); const pid = `${repo.owner}/${repo.name}`.replace(/\//g, '%2F');
  await this.glab(['api', '--method', 'POST', `projects/${pid}/pipelines/${runId}/retry`], cwd);
}

async postPRComment(cwd: string, n: number, body: string): Promise<void> {
  await this.glab(['mr', 'note', String(n), '--message', body], cwd);
}
```

- [ ] **Step 2:** Adjust `listReviewThreads` to emit `threadId = "<mr_iid>:<discussion_id>"` so reply/resolve receive it back. Update callers if necessary (they currently just pass the string through).

- [ ] **Step 3:** Tests mocking `exec`; commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(vcs-gitlab): GitLabAdapter write-side (create/merge/reply/resolve/retry)"
```

---

## Task 3: Adapter factory + auto-detection at registration

**Files:** Modify `src/server/vcs/index.ts`, `src/server/commands.ts`.

- [ ] **Step 1:** `vcs/index.ts`:

```ts
import type { VcsAdapter } from './adapter';
import { GitHubAdapter } from './github';
import { GitLabAdapter } from './gitlab';

export function getVcsAdapter(kind: 'github' | 'gitlab'): VcsAdapter {
  switch (kind) {
    case 'github': return new GitHubAdapter();
    case 'gitlab': return new GitLabAdapter();
  }
}
```

- [ ] **Step 2:** Repo registration: run `git remote get-url origin` + match against `github.com` / `gitlab.*` to pick default `vcs_kind`. User can override in settings.

- [ ] **Step 3:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(vcs): factory + auto-detect github/gitlab at repo registration"
```

---

## Task 4: UI — neutral-verb labels

**Files:** Create `src/server/vcs/labels.ts`; wire into web components.

- [ ] **Step 1:** Implement:

```ts
export interface VcsLabels { pr: string; prShort: string; thread: string; reviewer: string; check: string; }

export function vcsLabels(kind: 'github' | 'gitlab'): VcsLabels {
  return kind === 'gitlab'
    ? { pr: 'Merge request', prShort: 'MR', thread: 'Discussion', reviewer: 'Reviewer', check: 'Pipeline job' }
    : { pr: 'Pull request', prShort: 'PR', thread: 'Thread', reviewer: 'Reviewer', check: 'Check' };
}
```

- [ ] **Step 2:** In `TopicHeader`, instead of hard-coded `PR #<n>`, render `vcsLabels(repo.vcsKind).prShort + ' #' + n` (e.g., `MR !213` format — actually GitLab uses `!` not `#`; include this nuance in the helper):

```ts
export function prRef(kind: 'github'|'gitlab', n: number): string {
  return kind === 'gitlab' ? `MR !${n}` : `PR #${n}`;
}
```

- [ ] **Step 3:** Neutral verbs (`Send for review`, `Address feedback`, `Merge`, `Sync with main`) stay unchanged across both VCS — do NOT change these strings.

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(ui): vcsLabels helper for power-user surfaces"
```

---

## Task 5: End-to-end on dag_bpay

**Files:** None (manual validation) + regression tests on fixtures.

- [ ] **Step 1:** Register `../dag_bpay` via the repo registration endpoint. Verify `vcs_kind=gitlab`, `canonical_remote`/`fork_remote` correct, `branch_template = {type}/{project}/{ticket}-{slug}` detected.

- [ ] **Step 2:** Create a Standard topic with a YouTrack ticket (once MCP configured; otherwise free-form). Verify the attempt's worktree is cut on a branch matching `feature/cbp/CBP-XXXX-<slug>`.

- [ ] **Step 3:** Open MR via Create PR button; verify the MR appears in GitLab; verify title is `CBP-XXXX: <subject>` format.

- [ ] **Step 4:** Simulate a failing pipeline; Fix CI spawns a task whose initial prompt contains the job's failing log tail.

- [ ] **Step 5:** Merge via Merge button; verify MR merges with squash and the topic moves to Merged.

- [ ] **Step 6:** Capture one run's `glab` output per method used in Step 1–5 to `tests/fixtures/glab-output/` and add regression tests if not already covered.

---

## Task 6: README + roadmap polish

**Files:** Modify `README.md`.

- [ ] **Step 1:** Update roadmap to reflect GitLab support as shipped and clarify remaining follow-ups (multi-user, Slack, permissions).

- [ ] **Step 2:** Add a "Repo compatibility" mini-section listing tested repo shapes (GitHub direct, GitHub fork, GitLab direct, GitLab fork) and the known-working tracker adapters.

- [ ] **Step 3:** Commit:
```bash
git add README.md
git commit -m "docs(readme): GitLab shipped; refreshed roadmap and compatibility matrix"
```

---

## Task 7: Migration finalization

**Files:** Modify `src/server/migration.ts`.

- [ ] **Step 1:** The Plan 1 migration created a synthetic `legacy` topic per origin. By now (after several plans) it should be safe to attempt a second-pass inference: for each legacy task with a `worktree_branch` matching the new `branch_template`, extract a ticket key and title from the branch name and promote the task into a proper Draft topic.

- [ ] **Step 2:** Guard behind a preference `CLAUDEX_FINAL_MIGRATION=1` env var so existing installations opt in.

- [ ] **Step 3:** Tests cover the promotion logic on a fixture DB with sample legacy tasks.

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(migration): opt-in promotion of legacy tasks into proper Draft topics"
```

---

## Task 8: Full verification + release notes

- [ ] **Step 1:** `npx vitest run && npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npm run build`.

- [ ] **Step 2:** Smoke: open dashboard against an SQLite with rows from gdc-nas (GitHub), dag_bpay (GitLab), and the bare test repo. Every topic detail page renders without error.

- [ ] **Step 3:** Author release notes summarising what's in across Plans 1–6. (Skip if release cadence doesn't use them.)

---

## Plan 6 done when

- dag_bpay works end-to-end identically to gdc-nas via the adapter swap.
- Neutral verbs work both backends; power-user strings (`PR #123` vs `MR !213`) switch correctly.
- Opt-in migration promotes legacy tasks to proper topics where the branch name reveals a ticket.
- README reflects shipped scope; roadmap lists only true follow-ups (multi-user, Slack, permissions).
- All six plans executed; full spec coverage verified (see final summary).
