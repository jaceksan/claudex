# Worktree/Topic/Task — Plan 2: Topic creation + Draft phase

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-04-17-worktree-topic-task-ux-design.md`
**Depends on:** Plan 1 (foundations).

**Goal:** Users can create a topic, run parallel attempts in worktrees, accept one, and see the topic branch populated locally. No PR yet. Dashboard pivots to topic cards. Broadcast UI, in-app toaster, and per-session launcher button are removed in this plan.

**Architecture:** Extend `SessionManager` with `TopicManager` sitting in front of it. New WS envelopes for topic creation and attempt acceptance. Reuse existing `worktree.ts` with per-repo branch-template interpolation. Dashboard component splits into `TopicGrid` + `TopicCard`.

**Tech Stack:** As Plan 1 + React/Tailwind.

---

## File Structure

**New:**
- `src/server/topic-manager.ts` — orchestrates topic creation and attempt lifecycle.
- `src/server/branch-template.ts` — interpolate `{gh_user}/{ticket}_{slug}` with placeholders.
- `src/server/slug.ts` — `slugify(title)` helper (shared).
- `src/server/ws/topic-envelope.ts` — topic-related WS types.
- `src/web/components/topic-card.tsx`, `src/web/components/topic-grid.tsx`.
- `src/web/components/new-topic-modal.tsx` (replaces LauncherModal as primary entry).
- `src/web/hooks/use-topics.ts` — fetches topic list via WS/HTTP.
- `tests/topic-manager.test.ts`, `tests/branch-template.test.ts`.

**Modify:**
- `src/server/worktree.ts` — accept a branch name argument instead of auto-constructing.
- `src/server/session/manager.ts` — expose an attempt-spawning helper that takes `topicId` + `childBranch`.
- `src/server/ws/envelope.ts` — add new message types.
- `src/server/ws/hub.ts` — dispatch new envelopes.
- `src/server/commands.ts` — add HTTP handlers for topic listing.
- `src/web/pages/dashboard.tsx` — replace flat session grid with topic grid; remove Broadcast + toaster.
- `src/web/components/launcher.tsx` — remove or repurpose as the Advanced "edit in place" modal.
- `src/web/components/toaster.tsx` — delete (or commented-out disable) per spec §15.
- `src/web/components/broadcast-modal.tsx` — delete.

---

## Task 1: Branch template + slug helpers

**Files:** Create `src/server/branch-template.ts`, `src/server/slug.ts`; tests.

- [ ] **Step 1:** Test for `slugify`:

```ts
import { describe, it, expect } from 'vitest';
import { slugify } from '../src/server/slug';

describe('slugify', () => {
  it('lowercases, dashes, strips punctuation', () => {
    expect(slugify('Fix: Login copy!')).toBe('fix-login-copy');
  });
  it('truncates to 40 chars by default', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(40);
  });
});
```

- [ ] **Step 2:** Create `src/server/slug.ts`:

```ts
export function slugify(input: string, max = 40): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
}
```

- [ ] **Step 3:** Test for branch-template:

```ts
import { describe, it, expect } from 'vitest';
import { renderBranchTemplate } from '../src/server/branch-template';

describe('renderBranchTemplate', () => {
  it('interpolates gh-style', () => {
    expect(renderBranchTemplate('{gh_user}/{ticket}_{slug}', {
      gh_user: 'jaceksan', ticket: 'ABC-123', slug: 'fix-login-copy',
    })).toBe('jaceksan/ABC-123_fix-login-copy');
  });
  it('interpolates dag_bpay-style', () => {
    expect(renderBranchTemplate('{type}/{project}/{ticket}-{slug}', {
      type: 'feature', project: 'cbp', ticket: 'CBP-1234', slug: 'payout-retry',
    })).toBe('feature/cbp/CBP-1234-payout-retry');
  });
  it('drops empty placeholders cleanly', () => {
    expect(renderBranchTemplate('{gh_user}/{ticket}_{slug}', {
      gh_user: 'jaceksan', ticket: '', slug: 's',
    })).toBe('jaceksan/s');
  });
  it('renders attempt suffix', () => {
    expect(renderBranchTemplate('__attempt-{n}', { n: '2' })).toBe('__attempt-2');
  });
});
```

- [ ] **Step 4:** Create `src/server/branch-template.ts`:

```ts
type Ctx = Record<string, string>;

export function renderBranchTemplate(template: string, ctx: Ctx): string {
  const rendered = template.replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? '');
  return rendered
    .replace(/[_\-/]{2,}/g, (m) => m[0])
    .replace(/^[_\-/]+|[_\-/]+$/g, '')
    .replace(/\/{2,}/g, '/');
}
```

- [ ] **Step 5:** Run tests; commit:
```bash
git add src/server/slug.ts src/server/branch-template.ts tests/branch-template.test.ts tests/slug.test.ts 2>/dev/null || true
CLAUDEX_SKIP_README=1 git commit -m "feat(branch): slugify + renderBranchTemplate helpers"
```

---

## Task 2: Adapt `worktree.ts` to take a caller-provided branch

**Files:** Modify `src/server/worktree.ts`.

- [ ] **Step 1:** Change `createWorktree(sourceCwd, uiId, label)` → `createWorktree(sourceCwd, uiId, opts: { branch: string; base?: string })`.

```ts
export function createWorktree(sourceCwd: string, uiId: string, opts: { branch: string; base?: string }): WorktreeInfo {
  const origin = resolveGitRoot(sourceCwd);
  if (!origin) throw new Error(`Worktree requested but ${sourceCwd} is not inside a git repository.`);
  const wtPath = path.join(worktreeRoot(), uiId);
  if (existsSync(wtPath)) { try { rmSync(wtPath, { recursive: true, force: true }); } catch {} }
  const args = ['worktree', 'add', '-b', opts.branch];
  if (opts.base) args.push(wtPath, opts.base); else args.push(wtPath);
  run('git', args, origin);
  return { path: wtPath, origin, branch: opts.branch };
}
```

- [ ] **Step 2:** Update callers in `session/manager.ts` to pass the branch name; temporary shim to keep old behaviour if no topic context.

- [ ] **Step 3:** Run existing tests; fix breakage.

- [ ] **Step 4:** Commit:
```bash
git add src/server/worktree.ts src/server/session/manager.ts
CLAUDEX_SKIP_README=1 git commit -m "refactor(worktree): accept explicit branch and optional base"
```

---

## Task 3: `TopicManager` — create topic (Draft phase, non-Exploration)

**Files:** Create `src/server/topic-manager.ts`; create `tests/topic-manager.test.ts`.

- [ ] **Step 1:** Write failing test covering the happy path — create a Standard topic with one attempt, verify topic row, topic branch cut, attempt-1 child branch cut, worktree created, session spawned.

Mock the `SessionManager.create` + git operations via injectable deps so the test doesn't touch a real repo.

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore } from '../src/server/repo';
import { TopicStore } from '../src/server/topic';
import { TaskStore } from '../src/server/task';
import { TopicManager } from '../src/server/topic-manager';

describe('TopicManager.create', () => {
  let db: Database.Database; let repos: RepoStore; let topics: TopicStore; let tasks: TaskStore;
  let gitCalls: Array<{ cmd: string; args: string[]; cwd?: string }>;
  let mgr: TopicManager;

  beforeEach(() => {
    db = new Database(':memory:'); ensureSchema(db);
    repos = new RepoStore(db); topics = new TopicStore(db); tasks = new TaskStore(db);
    gitCalls = [];
    mgr = new TopicManager({
      db, repos, topics, tasks,
      git: async (args, cwd) => { gitCalls.push({ cmd: 'git', args, cwd }); return ''; },
      createWorktree: (cwd, id, opts) => ({ path: `/tmp/wt/${id}`, origin: cwd, branch: opts.branch }),
      spawnSession: async ({ cwd, label, prompt }) => {
        db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,?,?,'running',?,?)")
          .run(`sess_${Math.random().toString(36).slice(2,8)}`, cwd, label, Date.now(), Date.now());
        return db.prepare('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1').get() as { id: string };
      },
      now: () => 1700000000000,
      githubLogin: async () => 'jaceksan',
    });
  });

  it('creates Draft topic with attempt-1 when template=standard', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic, task } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'Fix login copy', ticketKey: 'ABC-123',
      firstTask: { prompt: 'start', effort: 'medium', permissionMode: 'acceptEdits' },
    });
    expect(topic.phase).toBe('Draft');
    expect(topic.topicBranch).toBe('jaceksan/ABC-123_fix-login-copy');
    expect(task.type).toBe('attempt');
    expect(task.childBranch).toBe('jaceksan/ABC-123_fix-login-copy__attempt-1');
    // Fetched canonical/default, cut topic branch, then cut attempt branch via createWorktree.
    expect(gitCalls.map((c) => c.args[0])).toContain('fetch');
    expect(gitCalls.map((c) => c.args[0])).toContain('branch'); // topic branch via `git branch`
  });

  it('creates Exploring topic with no branch/worktree when template=exploration', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const { topic, task } = await mgr.create({
      repoId: repo.id, template: 'exploration',
      title: 'Explore refactor',
      firstTask: { effort: 'medium', permissionMode: 'plan' },
    });
    expect(topic.phase).toBe('Exploring');
    expect(topic.topicBranch).toBeNull();
    expect(task.childBranch).toBeNull();
    expect(task.worktreePath).toBeNull();
  });
});
```

- [ ] **Step 2:** Create `src/server/topic-manager.ts`:

```ts
import type Database from 'better-sqlite3';
import type { RepoStore } from './repo';
import type { TopicStore, TopicTemplate } from './topic';
import type { TaskStore } from './task';
import { renderBranchTemplate } from './branch-template';
import { slugify } from './slug';

interface SpawnedSession { id: string; }
type Git = (args: string[], cwd?: string) => Promise<string>;
type CreateWt = (cwd: string, uiId: string, opts: { branch: string; base?: string }) => { path: string; origin: string; branch: string };

export interface TopicManagerDeps {
  db: Database.Database;
  repos: RepoStore;
  topics: TopicStore;
  tasks: TaskStore;
  git: Git;
  createWorktree: CreateWt;
  spawnSession: (args: { cwd: string; label: string; prompt?: string; effort: string; permissionMode: string }) => Promise<SpawnedSession>;
  now: () => number;
  githubLogin: () => Promise<string>;
}

export interface CreateTopicInput {
  repoId: string;
  template: TopicTemplate;
  title: string;
  ticketKey?: string | null;
  type?: string; project?: string;
  firstTask: { prompt?: string; effort: string; permissionMode: string; label?: string };
}

export class TopicManager {
  constructor(private d: TopicManagerDeps) {}

  async create(input: CreateTopicInput) {
    const repo = this.d.repos.getById(input.repoId);
    if (!repo) throw new Error(`repo ${input.repoId} not found`);
    const slug = slugify(input.title);

    if (input.template === 'exploration') {
      const topic = this.d.topics.create({
        repoId: repo.id, phase: 'Exploring', template: 'exploration',
        title: input.title, slug, ticketKey: input.ticketKey ?? null, topicBranch: null,
      });
      const session = await this.d.spawnSession({
        cwd: repo.path, label: input.firstTask.label ?? 'explore',
        prompt: input.firstTask.prompt, effort: input.firstTask.effort,
        permissionMode: input.firstTask.permissionMode,
      });
      const task = this.d.tasks.create({
        sessionId: session.id, topicId: topic.id, type: 'free', label: 'explore',
      });
      return { topic, task };
    }

    // Draft phase — cut topic branch + attempt-1
    const ghUser = await this.d.githubLogin();
    const branchCtx: Record<string, string> = {
      gh_user: ghUser, ticket: input.ticketKey ?? '', slug,
      type: input.type ?? '', project: input.project ?? '',
    };
    const topicBranch = renderBranchTemplate(repo.branchTemplate, branchCtx);

    await this.d.git(['fetch', repo.canonicalRemote, repo.defaultBranch], repo.path);
    await this.d.git(['branch', topicBranch, `${repo.canonicalRemote}/${repo.defaultBranch}`], repo.path);

    const topic = this.d.topics.create({
      repoId: repo.id, phase: 'Draft', template: input.template,
      title: input.title, slug, ticketKey: input.ticketKey ?? null, topicBranch,
    });

    const attemptBranch = topicBranch + renderBranchTemplate(repo.attemptSuffix, { n: '1' });
    // We don't spawn session first — we need the session id for the worktree path, but we can mint one ahead of time.
    const session = await this.d.spawnSession({
      cwd: repo.path, // placeholder cwd; real cwd set after worktree
      label: input.firstTask.label ?? 'attempt-1',
      prompt: input.firstTask.prompt, effort: input.firstTask.effort,
      permissionMode: input.firstTask.permissionMode,
    });
    const wt = this.d.createWorktree(repo.path, session.id, { branch: attemptBranch, base: topicBranch });
    // Re-target session cwd to the worktree (spawnSession interface updated to accept a follow-up set-cwd call).
    this.d.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(wt.path, session.id);

    const task = this.d.tasks.create({
      sessionId: session.id, topicId: topic.id, type: 'attempt',
      label: input.firstTask.label ?? 'attempt-1',
      childBranch: attemptBranch, worktreePath: wt.path,
    });
    return { topic, task };
  }
}
```

- [ ] **Step 3:** Run tests. Expected: PASS.

- [ ] **Step 4:** Commit:
```bash
git add src/server/topic-manager.ts tests/topic-manager.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(topic-manager): create Draft/Exploring topics with attempt-1 wiring"
```

---

## Task 4: `TopicManager` — additional attempts and accept

**Files:** Extend `src/server/topic-manager.ts`; extend `tests/topic-manager.test.ts`.

- [ ] **Step 1:** Add tests for:
  - `addAttempt(topicId)` — cuts a new worktree off the topic branch, new child branch `__attempt-N` where N is max+1.
  - `acceptAttempt(taskSessionId)` — `git merge --squash` the attempt child into the topic branch locally, mark task accepted, mark sibling attempts discarded.
  - `discardAttempt(taskSessionId)` — mark task discarded; no branch deletion yet (GC in Plan 4).

- [ ] **Step 2:** Implement the three methods. Key behaviour:
  - Accept runs `git merge --squash <child>` on topic branch + commit with `commit_template`-rendered message.
  - Accept sets `topic.accepted_attempt_id`.

```ts
async addAttempt(topicId: string, args: { prompt?: string; effort: string; permissionMode: string; label?: string }) {
  const topic = this.d.topics.getById(topicId); if (!topic) throw new Error(`topic ${topicId} not found`);
  const repo = this.d.repos.getById(topic.repoId)!;
  if (topic.phase !== 'Draft') throw new Error(`cannot add attempt: phase ${topic.phase}`);
  if (topic.acceptedAttemptId) throw new Error('cannot add attempt after accept — use fix task');
  const existing = this.d.tasks.listByTopic(topicId).filter((t) => t.type === 'attempt');
  const n = String(existing.length + 1);
  const attemptBranch = topic.topicBranch! + renderBranchTemplate(repo.attemptSuffix, { n });
  const session = await this.d.spawnSession({
    cwd: repo.path, label: args.label ?? `attempt-${n}`,
    prompt: args.prompt, effort: args.effort, permissionMode: args.permissionMode,
  });
  const wt = this.d.createWorktree(repo.path, session.id, { branch: attemptBranch, base: topic.topicBranch! });
  this.d.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(wt.path, session.id);
  return this.d.tasks.create({
    sessionId: session.id, topicId, type: 'attempt',
    label: args.label ?? `attempt-${n}`, childBranch: attemptBranch, worktreePath: wt.path,
  });
}

async acceptAttempt(sessionId: string) {
  const task = this.d.tasks.getBySession(sessionId); if (!task) throw new Error('task not found');
  const topic = this.d.topics.getById(task.topicId)!;
  const repo = this.d.repos.getById(topic.repoId)!;
  if (task.type !== 'attempt') throw new Error('not an attempt task');
  // Squash merge child into topic (locally).
  await this.d.git(['checkout', topic.topicBranch!], repo.path);
  await this.d.git(['merge', '--squash', task.childBranch!], repo.path);
  await this.d.git(['commit', '-m', `${topic.ticketKey ? topic.ticketKey + ': ' : ''}${topic.title}`], repo.path);
  this.d.tasks.markAccepted(sessionId);
  this.d.topics.setPhase(topic.id, 'Draft', { acceptedAttemptId: sessionId });
  // Discard sibling attempt tasks.
  for (const t of this.d.tasks.listByTopic(topic.id)) {
    if (t.type === 'attempt' && t.sessionId !== sessionId && !t.acceptedAt && !t.discardedAt) {
      this.d.tasks.markDiscarded(t.sessionId);
    }
  }
}

async discardAttempt(sessionId: string) {
  const task = this.d.tasks.getBySession(sessionId); if (!task) throw new Error('task not found');
  this.d.tasks.markDiscarded(sessionId);
}
```

- [ ] **Step 3:** Run tests. Fix issues. Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(topic-manager): addAttempt/acceptAttempt/discardAttempt"
```

---

## Task 5: WS envelopes for topic ops

**Files:** Create `src/server/ws/topic-envelope.ts`; modify `src/server/ws/envelope.ts`, `src/server/ws/hub.ts`.

- [ ] **Step 1:** Define message types:

```ts
// src/server/ws/topic-envelope.ts
export type TopicClientMessage =
  | { type: 'client.topic.create'; payload: { repoId: string; template: 'quick-fix'|'standard'|'exploration'; title: string; ticketKey?: string; type?: string; project?: string; firstTask: { prompt?: string; effort: string; permissionMode: string; label?: string } } }
  | { type: 'client.topic.addAttempt'; payload: { topicId: string; prompt?: string; effort: string; permissionMode: string; label?: string } }
  | { type: 'client.topic.accept'; payload: { sessionId: string } }
  | { type: 'client.topic.discard'; payload: { sessionId: string } }
  | { type: 'client.topic.list'; payload: { repoId?: string } };

export type TopicServerMessage =
  | { type: 'server.topic.state'; payload: { topics: TopicCard[] } }
  | { type: 'server.topic.created'; payload: { topicId: string; sessionId: string } }
  | { type: 'server.topic.error'; payload: { message: string; ctx?: string } };

export interface TopicCard {
  id: string; repoId: string; phase: string; template: string;
  ticketKey: string | null; title: string;
  topicBranch: string | null; prNumber: number | null;
  taskSummary: { running: number; accepted: number; discarded: number };
  lastEventAt: number;
}
```

- [ ] **Step 2:** Wire into `hub.ts`. On each `client.topic.*` message, call the appropriate `TopicManager` method, then broadcast updated `server.topic.state` to all subscribers.

- [ ] **Step 3:** Add integration test `tests/integration-topic.test.ts` that boots a test server with in-memory SQLite + stub git/worktree/spawn, sends `client.topic.create`, asserts `server.topic.created`.

- [ ] **Step 4:** Commit:
```bash
git add src/server/ws/ tests/integration-topic.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(ws): topic create/accept/discard envelopes"
```

---

## Task 6: Dashboard pivot — TopicGrid + TopicCard

**Files:** Create `src/web/components/topic-card.tsx`, `src/web/components/topic-grid.tsx`, `src/web/hooks/use-topics.ts`; modify `src/web/pages/dashboard.tsx`.

- [ ] **Step 1:** `use-topics.ts` — subscribes to `server.topic.state` via existing `useWs` hook; returns topics array + `createTopic()`, `addAttempt()`, `accept()`, `discard()` callbacks.

- [ ] **Step 2:** `topic-card.tsx` — card layout per spec §4.2:

```tsx
import type { TopicCard as T } from '../../server/ws/topic-envelope';

export function TopicCard({ topic, onOpen }: { topic: T; onOpen: () => void }) {
  const stage = topic.phase;
  const pill = stagePillClass(stage);
  const summary = `${topic.taskSummary.running} running · ${topic.taskSummary.accepted} done · ${topic.taskSummary.discarded} archived`;
  return (
    <button onClick={onOpen} className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-left hover:border-zinc-700">
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">{topic.ticketKey ?? 'free-form'}</div>
        <span className={`rounded-full px-2 py-0.5 text-xs ${pill}`}>{stage}</span>
      </div>
      <div className="mt-1 text-sm font-medium text-zinc-100">{topic.title}</div>
      <div className="mt-2 text-xs text-zinc-500">{summary}</div>
      {topic.prNumber && <div className="mt-1 text-xs text-blue-300">PR #{topic.prNumber}</div>}
    </button>
  );
}

function stagePillClass(phase: string): string {
  switch (phase) {
    case 'Exploring': return 'bg-violet-900/40 text-violet-200';
    case 'Draft': return 'bg-zinc-800 text-zinc-200';
    case 'Open': return 'bg-emerald-900/40 text-emerald-200';
    case 'Merged': return 'bg-sky-900/40 text-sky-200';
    case 'Closed': return 'bg-zinc-800 text-zinc-500';
    default: return 'bg-zinc-800';
  }
}
```

- [ ] **Step 3:** `topic-grid.tsx` — responsive grid; sort topics by Plan 1 §4.4 (Inbox items → running → idle recent → archive). Archive section collapsed by default.

- [ ] **Step 4:** Replace `dashboard.tsx` body:
  - Remove imports for `broadcast-modal`, `toaster`, session-cards.
  - Add `+ New topic` button (opens `NewTopicModal`, Task 7).
  - Render `TopicGrid`.
  - Keep filters (`Mine`, `Active only`) if they exist; else defer to later.

- [ ] **Step 5:** Delete `src/web/components/broadcast-modal.tsx`, `src/web/components/toaster.tsx`. Remove their usage everywhere.

- [ ] **Step 6:** Typecheck + run dev server manually; click `+ New topic` (button exists but modal will be empty until Task 7).

- [ ] **Step 7:** Commit:
```bash
git add src/web/components/topic-card.tsx src/web/components/topic-grid.tsx src/web/hooks/use-topics.ts src/web/pages/dashboard.tsx
git rm src/web/components/broadcast-modal.tsx src/web/components/toaster.tsx
CLAUDEX_SKIP_README=1 git commit -m "feat(dashboard): pivot to TopicGrid; remove Broadcast + toaster"
```

---

## Task 7: New topic modal

**Files:** Create `src/web/components/new-topic-modal.tsx`; modify `src/web/pages/dashboard.tsx`.

- [ ] **Step 1:** Modal fields (spec §6.2):
  - Source: radio `From ticket` (disabled in this plan — wired in Plan 5) / `Free-form`.
  - Repo: dropdown of registered repos (list from `server.repo.state`, which we need to add in this task).
  - Template: radio cards `Quick fix` / `Standard` ★ / `Exploration`.
  - Initial prompt: textarea (optional for exploration).
  - Effort / permission mode: selects.
  - Advanced (collapsed): base branch, `type`, `project`, `Edit in place` checkbox (disabled in this plan — shown only to note UI presence).
  - Submit button `Create topic`.

- [ ] **Step 2:** Add `client.repo.list` / `server.repo.state` envelopes to surface registered repos. Backend lists via `RepoStore.list()`.

- [ ] **Step 3:** On submit, dispatch `client.topic.create`. On `server.topic.created` the dashboard navigates to the topic detail URL `/topic/<id>` (route added in Plan 3; for Plan 2, just stay on dashboard and show the new card).

- [ ] **Step 4:** Remove the old `+ New session` button and the `launcher.tsx` modal-open flow. Keep `launcher.tsx` renamed as `edit-in-place-modal.tsx` for the Advanced escape hatch — stubbed for now, wired in Plan 5.

- [ ] **Step 5:** Typecheck; run dev server; manually verify creating a topic from the modal works end-to-end against a real local git repo (or a tmp repo with a single commit on `main`).

- [ ] **Step 6:** Commit:
```bash
git add src/web/components/new-topic-modal.tsx src/web/pages/dashboard.tsx src/server/ws/
git mv src/web/components/launcher.tsx src/web/components/edit-in-place-modal.tsx
CLAUDEX_SKIP_README=1 git commit -m "feat(dashboard): New topic modal + repo list envelope"
```

---

## Task 8: Repo registration endpoint

**Files:** Modify `src/server/commands.ts` and WS; add test.

- [ ] **Step 1:** Add HTTP endpoint `POST /api/repo/register` taking `{ path }`; server resolves git root, fork topology (via `gh repo view --json parent`), and creates a `repo` row.

```ts
app.post('/api/repo/register', async (req, res) => {
  const { path } = req.body as { path: string };
  const root = resolveGitRoot(path);
  if (!root) return res.status(400).send({ error: 'Not a git repo' });
  const existing = repos.getByPath(root);
  if (existing) return res.send(existing);
  const adapter = new GitHubAdapter();
  const summary = await adapter.getRepo(root);
  const isFork = !!summary.parentOwner;
  const canonicalRemote = isFork ? 'upstream' : 'origin';
  const forkRemote = 'origin';
  const repo = repos.register({
    path: root, vcsKind: 'github',
    canonicalRemote, forkRemote, defaultBranch: summary.defaultBranch,
    canonicalOwner: isFork ? summary.parentOwner : summary.owner,
    canonicalName: isFork ? summary.parentName : summary.name,
    forkOwner: summary.owner, forkName: summary.name,
  });
  res.send(repo);
});
```

- [ ] **Step 2:** UI — `NewTopicModal`'s repo dropdown has an `+ Add repo…` entry opening a small dialog prompting for a path.

- [ ] **Step 3:** Unit-test `repo.register` wiring; manually test with a real repo.

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(repo): register endpoint + UI dropdown"
```

---

## Task 9: README update (enabled — real feature change)

**Files:** Modify `README.md`.

- [ ] **Step 1:** Replace the current "Git worktree isolation" bullet with a short rewrite referencing the topic/task model. Add bullet for "Parallel attempts on the same ticket with one-click accept."

- [ ] **Step 2:** Remove the "Broadcast" bullet from the feature list. Note in Limitations that Broadcast was removed.

- [ ] **Step 3:** Add to roadmap: Slack notifications; GitLab support; permissions model for non-tech multi-user (Plan 2 README addendum matches spec §16).

- [ ] **Step 4:** Commit (the PreToolUse hook will allow this because `README.md` is updated alongside user-visible changes):
```bash
git add README.md
git commit -m "docs(readme): topic/task model; drop Broadcast; add roadmap"
```

---

## Task 10: End-to-end smoke

- [ ] **Step 1:** `npm run build && npm start` and do the full flow manually: register a repo, create a Standard topic with a prompt, wait for attempt to finish, click `Use this attempt`, verify topic branch has a squash commit.
- [ ] **Step 2:** `git -C <repo> log --oneline main..<topic-branch>`: expect exactly 1 commit.
- [ ] **Step 3:** Restart server; verify topic + task rows survive.
- [ ] **Step 4:** Run full verification: `npx vitest run && npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npm run build:web`.

---

## Plan 2 done when

- New topic modal works end-to-end against a real repo.
- Dashboard shows topics (not flat sessions).
- Attempt branches + worktrees cut cleanly; accept produces a squash commit on topic branch.
- Broadcast UI / in-app toaster / per-session `+ New` button gone.
- Legacy sessions still visible (under legacy topic from Plan 1).
- No PR flow yet; that's Plan 3.
