# Worktree/Topic/Task — Plan 3: PR lifecycle (Open phase)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-04-17-worktree-topic-task-ux-design.md`
**Depends on:** Plans 1 and 2.

**Goal:** Full Topic-detail page with Comments, CI, and action bar. Create PR from a Draft topic. Fix workflows (per-comment, per-check, Address feedback). Watch CI with OS notifications on state transitions. Working end-to-end on gdc-nas-style repos with skills; works on skill-less repos via built-in fallbacks.

**Architecture:** Add a `PrLifecycle` service that owns the Open-phase state machine. Poll-driven PR state with a 30s in-memory cache. Topic-detail SPA route composes the three-column layout. Fix tasks are spawned via `TopicManager` with `type=fix-comments | fix-ci`. Skill invocation is string-based — initial prompt = slash command if bound.

---

## File Structure

**New:**
- `src/server/pr-lifecycle.ts` — createPR, refreshPr, fixWorkflows.
- `src/server/pr-cache.ts` — in-memory TTL cache keyed by `(repoId, prNumber)`.
- `src/server/skill-invoker.ts` — render initial prompt for a canonical action.
- `src/web/pages/topic.tsx` — Topic-detail page.
- `src/web/components/topic-header.tsx`, `.../timeline.tsx`, `.../task-panel.tsx`,
  `.../comments-panel.tsx`, `.../ci-panel.tsx`, `.../action-bar.tsx`.
- `src/web/hooks/use-topic-detail.ts`.
- `tests/pr-lifecycle.test.ts`, `tests/skill-invoker.test.ts`.

**Modify:**
- `src/server/ws/topic-envelope.ts` — add PR-related server messages.
- `src/server/topic-manager.ts` — wire `acceptAttempt` to optionally auto-Create-PR for `quick-fix` template.
- `src/server/notifications.ts` — add `ciStateChanged` kind; suppress in-app fallback (OS only).
- `src/web/pages/dashboard.tsx` — route click on a topic card to `/topic/:id`.

---

## Task 1: PR cache + refresh

**Files:** Create `src/server/pr-cache.ts`; test.

- [ ] **Step 1:** Test — cache returns within TTL; refetches after TTL; invalidation works.

- [ ] **Step 2:** Implement:

```ts
import type { VcsAdapter, PR, ReviewThread, Check } from './vcs/adapter';

export interface PrBundle { pr: PR; threads: ReviewThread[]; checks: Check[]; requiredContexts: string[]; fetchedAt: number; }

export class PrCache {
  private cache = new Map<string, PrBundle>();
  constructor(private adapter: VcsAdapter, private ttlMs = 30_000) {}

  async get(cwd: string, prNumber: number, defaultBranch: string, force = false): Promise<PrBundle> {
    const key = `${cwd}#${prNumber}`;
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.fetchedAt < this.ttlMs) return hit;
    const pr = await this.adapter.getPR(cwd, prNumber);
    const [threads, checks, required] = await Promise.all([
      this.adapter.listReviewThreads(cwd, prNumber),
      this.adapter.listChecks(cwd, pr.headBranch),
      this.adapter.getRequiredChecks(cwd, defaultBranch),
    ]);
    const bundle: PrBundle = { pr, threads, checks, requiredContexts: required, fetchedAt: Date.now() };
    this.cache.set(key, bundle);
    return bundle;
  }

  invalidate(cwd: string, prNumber: number): void { this.cache.delete(`${cwd}#${prNumber}`); }
}
```

- [ ] **Step 3:** Commit:
```bash
git add src/server/pr-cache.ts tests/pr-cache.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(pr): in-memory PR cache with TTL"
```

---

## Task 2: `SkillInvoker` — render initial prompt for an action

**Files:** Create `src/server/skill-invoker.ts`; test.

- [ ] **Step 1:** Test:

```ts
import { describe, it, expect } from 'vitest';
import { renderActionPrompt } from '../src/server/skill-invoker';

describe('renderActionPrompt', () => {
  it('returns skill slash command when bound', () => {
    expect(renderActionPrompt({
      action: 'pr-create', skills: { 'pr-create': '/pr-create' },
    })).toBe('/pr-create');
  });
  it('returns fallback prompt when unbound', () => {
    const p = renderActionPrompt({ action: 'pr-create', skills: {}, fallbackCtx: { title: 'T', body: 'B', base: 'main', head: 'h' } });
    expect(p).toContain('Create a pull request');
    expect(p).toContain('base branch main');
  });
  it('seeds fix-comments prompt with thread context', () => {
    const p = renderActionPrompt({
      action: 'fix-comments', skills: { 'pr-fix': '/pr-fix' },
      fixCtx: { threads: [{ id: 't1', path: 'a.ts', line: 42, body: 'Null-check' }] },
    });
    expect(p).toBe('/pr-fix');
  });
  it('falls back with explicit thread summary when unbound', () => {
    const p = renderActionPrompt({
      action: 'fix-comments', skills: {},
      fixCtx: { threads: [{ id: 't1', path: 'a.ts', line: 42, body: 'Null-check' }] },
    });
    expect(p).toContain('a.ts:42');
    expect(p).toContain('Null-check');
  });
});
```

- [ ] **Step 2:** Implement:

```ts
export type CanonicalAction = 'commit' | 'pr-create' | 'pr-review' | 'pr-fix' | 'ci-watch' | 'validate' | 'coding' | 'code-review';

export interface RenderInput {
  action: CanonicalAction;
  skills: Record<string, string>;
  fallbackCtx?: { title?: string; body?: string; base?: string; head?: string };
  fixCtx?: { threads?: { id: string; path: string | null; line: number | null; body: string }[]; checks?: { name: string; logTail: string }[] };
}

const FALLBACKS: Record<CanonicalAction, (i: RenderInput) => string> = {
  'pr-create': (i) => `Create a pull request titled "${i.fallbackCtx?.title ?? ''}" on base branch ${i.fallbackCtx?.base ?? 'main'} from head ${i.fallbackCtx?.head ?? ''}. Body: ${i.fallbackCtx?.body ?? ''}. Use gh pr create.`,
  'pr-fix': (i) => buildFixPrompt(i),
  'pr-review': (i) => buildFixPrompt(i),
  'ci-watch': (i) => buildFixPrompt({ ...i, fixCtx: { ...i.fixCtx, threads: undefined } }),
  commit: () => 'Stage changes and make a commit following repo conventions. Print the commit SHA.',
  validate: () => 'Run the project validation command for the changed files. Fix any failures.',
  coding: () => 'Implement the task described above.',
  'code-review': () => 'Produce a markdown code review under Review Structure (Summary, Changes, Review by File, Acceptance Criteria, Overall Verdict).',
};

function buildFixPrompt(i: RenderInput): string {
  const parts: string[] = ['Address the following and push a commit. Reply on each addressed item with the commit SHA.'];
  if (i.fixCtx?.threads?.length) {
    parts.push('## Review comments');
    for (const t of i.fixCtx.threads) parts.push(`- ${t.path ?? '(no path)'}:${t.line ?? '?'} — ${t.body}`);
  }
  if (i.fixCtx?.checks?.length) {
    parts.push('## Failing CI');
    for (const c of i.fixCtx.checks) parts.push(`- ${c.name}\n${c.logTail}`);
  }
  return parts.join('\n');
}

export function renderActionPrompt(input: RenderInput): string {
  const slug = input.action === 'fix-comments' ? 'pr-fix' : input.action === 'fix-ci' ? 'ci-watch' : input.action;
  const bound = input.skills[slug];
  if (bound) return bound;
  return FALLBACKS[slug as CanonicalAction](input);
}
```

(`fix-comments` / `fix-ci` are task types; they map to `pr-fix` / `ci-watch` skills.)

- [ ] **Step 3:** Commit:
```bash
git add src/server/skill-invoker.ts tests/skill-invoker.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(skills): render initial prompt per canonical action with fallbacks"
```

---

## Task 3: `PrLifecycle.createPR`

**Files:** Create `src/server/pr-lifecycle.ts`; test.

- [ ] **Step 1:** Test `createPR(topicId)` — fetches topic, pushes topic branch to fork remote, invokes VcsAdapter.createPR, stores pr_number on topic, phase → Open, marks Watch CI on.

- [ ] **Step 2:** Implement:

```ts
import type { RepoStore } from './repo';
import type { TopicStore } from './topic';
import type { VcsAdapter } from './vcs/adapter';
import type { PrCache } from './pr-cache';
import { renderBranchTemplate } from './branch-template';

export class PrLifecycle {
  constructor(
    private deps: {
      repos: RepoStore; topics: TopicStore; adapter: (repoId: string) => VcsAdapter;
      prCache: PrCache; git: (args: string[], cwd?: string) => Promise<string>;
    }
  ) {}

  async createPR(topicId: string, args: { title?: string; body?: string }): Promise<number> {
    const topic = this.deps.topics.getById(topicId); if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    if (!topic.topicBranch) throw new Error('topic has no branch');
    if (topic.phase !== 'Draft') throw new Error(`cannot create PR in phase ${topic.phase}`);
    await this.deps.git(['push', repo.forkRemote, topic.topicBranch], repo.path);
    const adapter = this.deps.adapter(repo.id);
    const title = args.title ?? `${topic.ticketKey ? topic.ticketKey + ': ' : ''}${topic.title}`;
    const body = args.body ?? (repo.prBodyTemplate ?? defaultBody(topic));
    const pr = await adapter.createPR({ cwd: repo.path, base: repo.defaultBranch, head: topic.topicBranch, title, body });
    this.deps.topics.setPhase(topicId, 'Open', { prNumber: pr.number });
    return pr.number;
  }
}

function defaultBody(topic: { title: string; ticketKey: string | null }): string {
  return `## Summary\n\n_TODO_\n\n## Test plan\n\n- [ ] _TODO_\n${topic.ticketKey ? `\nTicket: ${topic.ticketKey}\n` : ''}`;
}
```

- [ ] **Step 3:** Run tests. Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(pr): createPR pushes topic branch and opens PR via adapter"
```

---

## Task 4: `PrLifecycle` fix workflows

**Files:** Extend `src/server/pr-lifecycle.ts`.

- [ ] **Step 1:** Add methods that spawn fix tasks via `TopicManager`:

```ts
async addressFeedback(topicId: string, opts: { includeCi: boolean; includeComments: boolean }): Promise<{ sessionId: string }> {
  const topic = this.deps.topics.getById(topicId)!;
  const repo = this.deps.repos.getById(topic.repoId)!;
  const bundle = await this.deps.prCache.get(repo.path, topic.prNumber!, repo.defaultBranch);
  const threads = opts.includeComments
    ? bundle.threads.filter((t) => !t.isResolved && t.comments.some((c) => !c.isBot))
    : [];
  const failingRequired = opts.includeCi
    ? bundle.checks.filter((c) => c.conclusion === 'failure' && bundle.requiredContexts.includes(c.name))
    : [];
  if (threads.length === 0 && failingRequired.length === 0) throw new Error('nothing to address');
  const prompt = renderActionPrompt({
    action: threads.length && failingRequired.length ? 'pr-fix' : threads.length ? 'pr-fix' : 'ci-watch',
    skills: repo.skills,
    fixCtx: {
      threads: threads.flatMap((t) => t.comments.filter((c) => !c.isBot).map((c) => ({ id: t.id, path: c.path, line: c.line, body: c.body }))),
      checks: await Promise.all(failingRequired.map(async (c) => ({ name: c.name, logTail: await this.deps.git(['run', 'view', String(c.runId), '--log-failed'], repo.path).catch(() => '') }))),
    },
  });
  // TopicManager exposes addFixTask (implemented in Task 5).
  return this.deps.topicManager.addFixTask(topicId, {
    type: threads.length ? 'fix-comments' : 'fix-ci',
    prompt, effort: 'high', permissionMode: 'acceptEdits',
  });
}

async fixComment(topicId: string, threadId: string): Promise<{ sessionId: string }> { /* scope to one thread */ }
async fixCheck(topicId: string, checkName: string): Promise<{ sessionId: string }> { /* scope to one check */ }
```

- [ ] **Step 2:** Tests for both per-item and coarse variants. Mock adapter + cache.

- [ ] **Step 3:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(pr): addressFeedback/fixComment/fixCheck spawn fix tasks"
```

---

## Task 5: `TopicManager.addFixTask`

**Files:** Extend `src/server/topic-manager.ts`.

- [ ] **Step 1:** Implement:

```ts
async addFixTask(topicId: string, args: { type: 'fix-comments'|'fix-ci'; prompt: string; effort: string; permissionMode: string; label?: string; parentTrigger?: unknown }) {
  const topic = this.d.topics.getById(topicId)!; const repo = this.d.repos.getById(topic.repoId)!;
  if (topic.phase !== 'Open' && !(topic.phase === 'Draft' && topic.acceptedAttemptId)) throw new Error(`cannot add fix task in phase ${topic.phase}`);
  // Fix tasks cut off the current topic branch tip.
  const session = await this.d.spawnSession({ cwd: repo.path, label: args.label ?? args.type, prompt: args.prompt, effort: args.effort, permissionMode: args.permissionMode });
  const childBranch = `${topic.topicBranch}__fix-${session.id.slice(0,6)}`;
  const wt = this.d.createWorktree(repo.path, session.id, { branch: childBranch, base: topic.topicBranch! });
  this.d.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(wt.path, session.id);
  return this.d.tasks.create({
    sessionId: session.id, topicId, type: args.type,
    label: args.label ?? args.type, childBranch, worktreePath: wt.path,
    parentTrigger: args.parentTrigger,
  });
}
```

- [ ] **Step 2:** Add a concurrency guard: reject if any other task of type `fix-*` or `attempt` (post-accept) on this topic is currently running. Queue indicator surfaces later.

- [ ] **Step 3:** Tests. Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(topic-manager): addFixTask for Open-phase fix workflows"
```

---

## Task 6: Accept-fix-task flow

**Files:** Extend `src/server/topic-manager.ts`, `src/server/pr-lifecycle.ts`.

- [ ] **Step 1:** `acceptFixTask(sessionId)`:
  - `git checkout <topicBranch>; git merge --squash <childBranch>; git commit` (message rendered from `commit_template`).
  - `git push fork_remote <topicBranch>`.
  - Invalidate PR cache.
  - If triggered from specific threads (`task.parentTrigger.threadIds`), post `Fixed in <sha>` reply on each; auto-resolve bot threads; prompt-resolve human threads (UI confirms).

- [ ] **Step 2:** `discardFixTask(sessionId)` — mark task discarded; no push.

- [ ] **Step 3:** Tests mocking adapter and git; commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(topic-manager): acceptFixTask pushes + auto-reply/resolve"
```

---

## Task 7: CI watcher + OS notifications

**Files:** Modify `src/server/pr-lifecycle.ts`, `src/server/notifications.ts`.

- [ ] **Step 1:** Add `watchCi(topicId, enable)` to `PrLifecycle`:
  - Persists a flag (in-memory map or `topic.watch_ci` column — add via additive migration).
  - When enabled, schedules a 2-minute poll: `prCache.get(force: true)` then compares rollup to previous.
  - On state transition (running → ok, running → failed, any-new-failure-after-green) emits `notifications.ciStateChanged(topic, prev, curr)`.

- [ ] **Step 2:** In `notifications.ts`, add a dedicated `ciStateChanged` kind. Use only the OS backend; do not emit in-app events (toaster removed in Plan 2).

- [ ] **Step 3:** Auto-enable Watch on `createPR`; auto-disable on PR merge/close.

- [ ] **Step 4:** Test the emit path with a fake PrCache that flips states.

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(ci): Watch CI + OS notifications on state transitions"
```

---

## Task 8: Topic detail page shell

**Files:** Create `src/web/pages/topic.tsx` + child components; route from dashboard.

- [ ] **Step 1:** Add route. In `src/web/App.tsx` (or equivalent), add a `/topic/:id` route; clicking a topic card navigates there.

- [ ] **Step 2:** `use-topic-detail.ts` hook — on mount, subscribes via WS to `server.topic.detail` events for the given id; calls a `client.topic.subscribe` with that id on mount; unsubscribes on unmount. Server returns bundle `{ topic, tasks, pr?, threads?, checks?, required? }`.

- [ ] **Step 3:** `topic.tsx` composes:

```
<TopicHeader ... />
<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
  <Timeline topic={...} tasks={...} pr={...} />
  <TaskPanel tasks={...} onOpen={...} onAccept={...} onDiscard={...} />
  <ReviewActivity threads={...} checks={...} required={...} onFix={...} />
</div>
<ActionBar topic={...} onCreatePR={...} onAddressFeedback={...} onMerge={...} ... />
```

- [ ] **Step 4:** `TopicHeader` — per spec §5.1; copy-button on branch.

- [ ] **Step 5:** `Timeline` — the stepper per §5.2; renders from topic phase + tasks + pr bundle.

- [ ] **Step 6:** `TaskPanel` — list of cards; click → `/session/:sessionId` (existing route); inline buttons for Accept/Discard when a task is idle.

- [ ] **Step 7:** `CommentsPanel` — renders `threads` only when PR open and threads.length>0. Cards with Fix/Reply/Resolve/Skip. Reply opens a small inline textbox → dispatches `client.thread.reply`.

- [ ] **Step 8:** `CiPanel` — rollup computed from `checks` filtered by `required` contexts. Failures listed inline; non-voting collapsed. Watch toggle dispatches `client.pr.watch`.

- [ ] **Step 9:** `ActionBar` — button-gating from spec §7.2 table, implemented as a small function `visibleActions(phase, flags)`.

- [ ] **Step 10:** Run dev server; manually test the page with a dashboard topic. Commit:
```bash
git add src/web/pages/topic.tsx src/web/components/topic-*.tsx src/web/components/timeline.tsx src/web/components/task-panel.tsx src/web/components/comments-panel.tsx src/web/components/ci-panel.tsx src/web/components/action-bar.tsx src/web/hooks/use-topic-detail.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(topic-page): three-column layout with header, timeline, tasks, comments, CI, actions"
```

---

## Task 9: Quick-fix template auto-accept + auto-PR

**Files:** Modify `src/server/topic-manager.ts`, `src/server/session/manager.ts`.

- [ ] **Step 1:** On session end (existing event wiring), if the session's task is an attempt of a `quick-fix` topic and the session ended with status `ended` (not crashed), call `topicManager.acceptAttempt(sessionId)`. Then if the topic template is `quick-fix`, call `prLifecycle.createPR(topicId, {})`.

- [ ] **Step 2:** Unit-tested via an integration test that drives a fake session end event through the hub.

- [ ] **Step 3:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(template): quick-fix auto-accept + auto-createPR on session end"
```

---

## Task 10: README update + smoke

- [ ] **Step 1:** README: add bullets for PR-creation from app; Watch CI; Address feedback; Per-comment/Per-check Fix.

- [ ] **Step 2:** Manual flow on a gdc-nas-style repo: create topic → accept attempt → Create PR → toggle Watch → introduce a failing check → verify OS notification fires → click Fix CI → verify fix task seeded with log tail.

- [ ] **Step 3:** `npx vitest run && npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npm run build:web`.

- [ ] **Step 4:** Commit README:
```bash
git commit -am "docs(readme): PR lifecycle, Watch CI, Fix workflows"
```

---

## Plan 3 done when

- User can create PR from a Draft topic with one click.
- Topic-detail page renders all three columns correctly across Draft/Open phases.
- Per-comment Fix, per-check Fix, Address feedback each spawn a correctly-seeded fix task.
- Accepting a fix task pushes to fork_remote and posts replies/resolves threads.
- Watch CI fires OS notifications on terminal state transitions.
- Quick-fix template end-to-end yields a merged-PR candidate with zero manual steps (still awaits human approval to merge, per compliance).
