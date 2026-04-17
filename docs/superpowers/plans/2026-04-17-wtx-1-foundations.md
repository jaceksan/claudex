# Worktree/Topic/Task — Plan 1: Foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-17-worktree-topic-task-ux-design.md`

**Goal:** Introduce `repo`/`topic`/`task` SQLite tables, a `VcsAdapter` abstraction with a GitHub implementation, a `TrackerAdapter` skeleton, and identity auto-wiring — with zero user-visible UI changes. Legacy sessions continue to work.

**Architecture:** Additive schema migration (same pattern as existing `worktree_*` columns). Adapters are TypeScript interfaces with a thin shell that shells out to `gh`. New tables start empty; legacy sessions are migrated to a synthetic `legacy` topic per repo on first boot.

**Tech Stack:** Node 20, TypeScript, `better-sqlite3`, `gh` CLI, vitest.

---

## File Structure

**New files:**
- `src/server/schema.ts` — pure schema helpers (additive column add, table create).
- `src/server/repo.ts` — `Repo` row, registration, identity cache lookups.
- `src/server/topic.ts` — `Topic` row, phase enum, CRUD.
- `src/server/task.ts` — `Task` row, type enum, CRUD, linkage to `sessions.id`.
- `src/server/migration.ts` — one-shot legacy-session → topic/task migration on boot.
- `src/server/vcs/adapter.ts` — `VcsAdapter` + common types (`PR`, `ReviewThread`, `Check`).
- `src/server/vcs/github.ts` — `GitHubAdapter` implementation over `gh`.
- `src/server/vcs/index.ts` — `getVcsAdapter(repoKind)` factory.
- `src/server/tracker/adapter.ts` — `TrackerAdapter` + `Ticket` type.
- `src/server/tracker/none.ts` — `NoneAdapter` (only one shipped in this plan).
- `src/server/tracker/index.ts` — factory.
- `tests/schema.test.ts`, `tests/repo.test.ts`, `tests/topic.test.ts`, `tests/task.test.ts`, `tests/migration.test.ts`, `tests/vcs-github.test.ts`.

**Modify:**
- `src/server/db.ts` — extract table/column setup to `schema.ts`; add `repo`/`topic`/`task`/`user` tables.
- `src/server/index.ts` — call `runMigrations(db)` on boot.
- `tests/fixtures/` — add `gh-output/` with JSON fixtures for GitHub API responses.

---

## Task 1: Extract schema to `schema.ts`

**Files:** Create `src/server/schema.ts`; modify `src/server/db.ts`; create `tests/schema.test.ts`.

- [ ] **Step 1:** Write failing test `tests/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';

describe('ensureSchema', () => {
  it('creates sessions, repo, topic, task, user tables if missing', () => {
    const db = new Database(':memory:');
    ensureSchema(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('repo');
    expect(names).toContain('topic');
    expect(names).toContain('task');
    expect(names).toContain('user');
    expect(names).toContain('prefs');
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    ensureSchema(db);
    ensureSchema(db);
    const repo = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='repo'").get() as { n: number };
    expect(repo.n).toBe(1);
  });
});
```

Run: `npx vitest run tests/schema.test.ts`. Expected: FAIL — module not found.

- [ ] **Step 2:** Create `src/server/schema.ts`:

```ts
import type Database from 'better-sqlite3';

export function ensureSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_event_at INTEGER NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repo (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      vcs_kind TEXT NOT NULL,
      canonical_remote TEXT NOT NULL,
      fork_remote TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      canonical_owner TEXT,
      canonical_name TEXT,
      fork_owner TEXT,
      fork_name TEXT,
      tracker_mcp TEXT,
      branch_template TEXT NOT NULL DEFAULT '{gh_user}/{ticket}_{slug}',
      commit_template TEXT NOT NULL DEFAULT '{subject}',
      attempt_suffix TEXT NOT NULL DEFAULT '__attempt-{n}',
      validate_cmd TEXT,
      pr_body_template TEXT,
      merge_strategy TEXT NOT NULL DEFAULT 'squash',
      required_checks_cache TEXT,
      required_checks_cache_at INTEGER,
      non_voting_overrides TEXT NOT NULL DEFAULT '[]',
      flaky_patterns TEXT NOT NULL DEFAULT '[]',
      flaky_tests TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '{}',
      known_types TEXT NOT NULL DEFAULT '[]',
      known_projects TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topic (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      template TEXT NOT NULL,
      ticket_key TEXT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      topic_branch TEXT,
      pr_number INTEGER,
      accepted_attempt_id TEXT,
      blocked_on_human INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      merged_at INTEGER,
      closed_at INTEGER,
      FOREIGN KEY (repo_id) REFERENCES repo(id)
    );
    CREATE TABLE IF NOT EXISTS task (
      session_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      parent_trigger TEXT,
      child_branch TEXT,
      worktree_path TEXT,
      accepted_at INTEGER,
      discarded_at INTEGER,
      triage_result TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES topic(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      github_login TEXT,
      preferred_template TEXT NOT NULL DEFAULT 'standard'
    );
    CREATE INDEX IF NOT EXISTS idx_topic_repo ON topic(repo_id);
    CREATE INDEX IF NOT EXISTS idx_task_topic ON task(topic_id);
  `);

  const sessionCols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  const addCol = (col: string, ddl: string) => {
    if (!sessionCols.includes(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
  };
  addCol('claude_session_id', 'claude_session_id TEXT');
  addCol('effort', "effort TEXT NOT NULL DEFAULT 'medium'");
  addCol('cum_cost', 'cum_cost REAL NOT NULL DEFAULT 0');
  addCol('cum_in', 'cum_in INTEGER NOT NULL DEFAULT 0');
  addCol('cum_out', 'cum_out INTEGER NOT NULL DEFAULT 0');
  addCol('turns', 'turns INTEGER NOT NULL DEFAULT 0');
  addCol('worktree_origin', 'worktree_origin TEXT');
  addCol('worktree_branch', 'worktree_branch TEXT');
}
```

- [ ] **Step 3:** Run test. Expected: PASS.

- [ ] **Step 4:** Refactor `src/server/db.ts` constructor to call `ensureSchema(this.db)` and remove the duplicated DDL/migration block.

- [ ] **Step 5:** Run full suite: `npx vitest run`. Expected: all existing tests green.

- [ ] **Step 6:** Commit:
```bash
git add src/server/schema.ts src/server/db.ts tests/schema.test.ts
CLAUDEX_SKIP_README=1 git commit -m "refactor(schema): extract schema to schema.ts; add repo/topic/task/user tables"
```

---

## Task 2: `Repo` entity and registration

**Files:** Create `src/server/repo.ts`; create `tests/repo.test.ts`.

- [ ] **Step 1:** Write failing test:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore, type RepoInput } from '../src/server/repo';

describe('RepoStore', () => {
  let db: Database.Database;
  let store: RepoStore;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    store = new RepoStore(db);
  });

  it('registers a new repo and returns it', () => {
    const input: RepoInput = {
      path: '/tmp/repo-a',
      vcsKind: 'github',
      canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
      canonicalOwner: 'acme', canonicalName: 'repo-a',
    };
    const r = store.register(input);
    expect(r.id).toMatch(/^repo_/);
    expect(r.path).toBe('/tmp/repo-a');
    expect(store.getByPath('/tmp/repo-a')?.id).toBe(r.id);
  });

  it('rejects duplicate paths', () => {
    store.register({ path: '/tmp/x', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    expect(() => store.register({ path: '/tmp/x', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' })).toThrow();
  });

  it('round-trips JSON columns', () => {
    const r = store.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    store.updateSkills(r.id, { commit: '/commit', 'pr-create': '/pr-create' });
    const r2 = store.getById(r.id)!;
    expect(r2.skills).toEqual({ commit: '/commit', 'pr-create': '/pr-create' });
  });
});
```

- [ ] **Step 2:** Create `src/server/repo.ts`:

```ts
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface RepoInput {
  path: string;
  vcsKind: 'github' | 'gitlab';
  canonicalRemote: string;
  forkRemote: string;
  defaultBranch: string;
  canonicalOwner?: string;
  canonicalName?: string;
  forkOwner?: string;
  forkName?: string;
  trackerMcp?: string | null;
  branchTemplate?: string;
  commitTemplate?: string;
  validateCmd?: string | null;
}

export interface Repo {
  id: string;
  path: string;
  vcsKind: 'github' | 'gitlab';
  canonicalRemote: string;
  forkRemote: string;
  defaultBranch: string;
  canonicalOwner: string | null;
  canonicalName: string | null;
  forkOwner: string | null;
  forkName: string | null;
  trackerMcp: string | null;
  branchTemplate: string;
  commitTemplate: string;
  attemptSuffix: string;
  validateCmd: string | null;
  prBodyTemplate: string | null;
  mergeStrategy: 'squash' | 'merge' | 'rebase';
  requiredChecksCache: string[] | null;
  requiredChecksCacheAt: number | null;
  nonVotingOverrides: string[];
  flakyPatterns: string[];
  flakyTests: string[];
  skills: Record<string, string>;
  knownTypes: string[];
  knownProjects: string[];
  createdAt: number;
}

export class RepoStore {
  constructor(private db: Database.Database) {}

  register(input: RepoInput): Repo {
    const id = `repo_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO repo (id, path, vcs_kind, canonical_remote, fork_remote, default_branch,
        canonical_owner, canonical_name, fork_owner, fork_name, tracker_mcp,
        branch_template, commit_template, validate_cmd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.path, input.vcsKind, input.canonicalRemote, input.forkRemote, input.defaultBranch,
      input.canonicalOwner ?? null, input.canonicalName ?? null,
      input.forkOwner ?? null, input.forkName ?? null,
      input.trackerMcp ?? null,
      input.branchTemplate ?? '{gh_user}/{ticket}_{slug}',
      input.commitTemplate ?? '{subject}',
      input.validateCmd ?? null,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): Repo | null {
    const row = this.db.prepare('SELECT * FROM repo WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  getByPath(path: string): Repo | null {
    const row = this.db.prepare('SELECT * FROM repo WHERE path=?').get(path) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  list(): Repo[] {
    return (this.db.prepare('SELECT * FROM repo ORDER BY created_at DESC').all() as Record<string, unknown>[])
      .map((r) => this.hydrate(r));
  }

  updateSkills(id: string, skills: Record<string, string>): void {
    this.db.prepare('UPDATE repo SET skills=? WHERE id=?').run(JSON.stringify(skills), id);
  }

  setNonVotingOverrides(id: string, overrides: string[]): void {
    this.db.prepare('UPDATE repo SET non_voting_overrides=? WHERE id=?').run(JSON.stringify(overrides), id);
  }

  setRequiredChecksCache(id: string, names: string[]): void {
    this.db.prepare('UPDATE repo SET required_checks_cache=?, required_checks_cache_at=? WHERE id=?')
      .run(JSON.stringify(names), Date.now(), id);
  }

  private hydrate(r: Record<string, unknown>): Repo {
    return {
      id: r.id as string, path: r.path as string, vcsKind: r.vcs_kind as 'github' | 'gitlab',
      canonicalRemote: r.canonical_remote as string, forkRemote: r.fork_remote as string,
      defaultBranch: r.default_branch as string,
      canonicalOwner: (r.canonical_owner as string) ?? null, canonicalName: (r.canonical_name as string) ?? null,
      forkOwner: (r.fork_owner as string) ?? null, forkName: (r.fork_name as string) ?? null,
      trackerMcp: (r.tracker_mcp as string) ?? null,
      branchTemplate: r.branch_template as string, commitTemplate: r.commit_template as string,
      attemptSuffix: r.attempt_suffix as string,
      validateCmd: (r.validate_cmd as string) ?? null, prBodyTemplate: (r.pr_body_template as string) ?? null,
      mergeStrategy: r.merge_strategy as 'squash' | 'merge' | 'rebase',
      requiredChecksCache: r.required_checks_cache ? JSON.parse(r.required_checks_cache as string) : null,
      requiredChecksCacheAt: (r.required_checks_cache_at as number) ?? null,
      nonVotingOverrides: JSON.parse(r.non_voting_overrides as string),
      flakyPatterns: JSON.parse(r.flaky_patterns as string),
      flakyTests: JSON.parse(r.flaky_tests as string),
      skills: JSON.parse(r.skills as string),
      knownTypes: JSON.parse(r.known_types as string),
      knownProjects: JSON.parse(r.known_projects as string),
      createdAt: r.created_at as number,
    };
  }
}
```

- [ ] **Step 3:** Run test: `npx vitest run tests/repo.test.ts`. Expected: PASS.

- [ ] **Step 4:** Commit:
```bash
git add src/server/repo.ts tests/repo.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(repo): RepoStore with register/list/getByPath/getById"
```

---

## Task 3: `Topic` entity

**Files:** Create `src/server/topic.ts`; create `tests/topic.test.ts`.

- [ ] **Step 1:** Write failing test exercising: create Draft topic, transition phase, find by PR number, list by repo.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore } from '../src/server/repo';
import { TopicStore, type TopicPhase } from '../src/server/topic';

describe('TopicStore', () => {
  let db: Database.Database; let repoId: string; let topics: TopicStore;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    const repos = new RepoStore(db);
    repoId = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' }).id;
    topics = new TopicStore(db);
  });

  it('creates a Draft topic with slug and retrieves by id', () => {
    const t = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'Fix login copy', slug: 'fix-login-copy', ticketKey: 'ABC-123', topicBranch: 'jaceksan/ABC-123_fix-login-copy' });
    expect(t.id).toMatch(/^topic_/);
    expect(topics.getById(t.id)?.title).toBe('Fix login copy');
  });

  it('transitions phase and persists', () => {
    const t = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'T', slug: 't' });
    topics.setPhase(t.id, 'Open', { prNumber: 4711 });
    const t2 = topics.getById(t.id)!;
    expect(t2.phase).toBe<TopicPhase>('Open');
    expect(t2.prNumber).toBe(4711);
  });

  it('findByPrNumber returns the topic', () => {
    const t = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'T', slug: 't' });
    topics.setPhase(t.id, 'Open', { prNumber: 99 });
    expect(topics.findByPrNumber(repoId, 99)?.id).toBe(t.id);
  });

  it('listByRepo excludes Merged/Closed by default, includes when asked', () => {
    const a = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'A', slug: 'a' });
    const b = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'B', slug: 'b' });
    topics.setPhase(b.id, 'Merged');
    expect(topics.listByRepo(repoId).map((t) => t.id)).toEqual([a.id]);
    expect(topics.listByRepo(repoId, { includeArchived: true }).length).toBe(2);
  });
});
```

- [ ] **Step 2:** Create `src/server/topic.ts`:

```ts
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export type TopicPhase = 'Exploring' | 'Draft' | 'Open' | 'Merged' | 'Closed';
export type TopicTemplate = 'quick-fix' | 'standard' | 'exploration';

export interface TopicInput {
  repoId: string;
  phase: TopicPhase;
  template: TopicTemplate;
  title: string;
  slug: string;
  ticketKey?: string | null;
  topicBranch?: string | null;
}
export interface Topic {
  id: string; repoId: string; phase: TopicPhase; template: TopicTemplate;
  ticketKey: string | null; title: string; slug: string;
  topicBranch: string | null; prNumber: number | null;
  acceptedAttemptId: string | null; blockedOnHuman: boolean;
  createdAt: number; mergedAt: number | null; closedAt: number | null;
}

export class TopicStore {
  constructor(private db: Database.Database) {}
  create(i: TopicInput): Topic {
    const id = `topic_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(`INSERT INTO topic (id, repo_id, phase, template, ticket_key, title, slug, topic_branch, blocked_on_human, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(id, i.repoId, i.phase, i.template, i.ticketKey ?? null, i.title, i.slug, i.topicBranch ?? null, now);
    return this.getById(id)!;
  }
  getById(id: string): Topic | null {
    const r = this.db.prepare('SELECT * FROM topic WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.hydrate(r) : null;
  }
  findByPrNumber(repoId: string, prNumber: number): Topic | null {
    const r = this.db.prepare('SELECT * FROM topic WHERE repo_id=? AND pr_number=?').get(repoId, prNumber) as Record<string, unknown> | undefined;
    return r ? this.hydrate(r) : null;
  }
  listByRepo(repoId: string, opts: { includeArchived?: boolean } = {}): Topic[] {
    const sql = opts.includeArchived
      ? 'SELECT * FROM topic WHERE repo_id=? ORDER BY created_at DESC'
      : "SELECT * FROM topic WHERE repo_id=? AND phase NOT IN ('Merged','Closed') ORDER BY created_at DESC";
    return (this.db.prepare(sql).all(repoId) as Record<string, unknown>[]).map((r) => this.hydrate(r));
  }
  setPhase(id: string, phase: TopicPhase, extra: { prNumber?: number; acceptedAttemptId?: string; topicBranch?: string } = {}): void {
    const now = Date.now();
    const parts: string[] = ['phase=?']; const args: unknown[] = [phase];
    if (extra.prNumber !== undefined) { parts.push('pr_number=?'); args.push(extra.prNumber); }
    if (extra.acceptedAttemptId !== undefined) { parts.push('accepted_attempt_id=?'); args.push(extra.acceptedAttemptId); }
    if (extra.topicBranch !== undefined) { parts.push('topic_branch=?'); args.push(extra.topicBranch); }
    if (phase === 'Merged') { parts.push('merged_at=?'); args.push(now); }
    if (phase === 'Closed') { parts.push('closed_at=?'); args.push(now); }
    args.push(id);
    this.db.prepare(`UPDATE topic SET ${parts.join(', ')} WHERE id=?`).run(...args);
  }
  setBlockedOnHuman(id: string, blocked: boolean): void {
    this.db.prepare('UPDATE topic SET blocked_on_human=? WHERE id=?').run(blocked ? 1 : 0, id);
  }
  private hydrate(r: Record<string, unknown>): Topic {
    return {
      id: r.id as string, repoId: r.repo_id as string,
      phase: r.phase as TopicPhase, template: r.template as TopicTemplate,
      ticketKey: (r.ticket_key as string) ?? null,
      title: r.title as string, slug: r.slug as string,
      topicBranch: (r.topic_branch as string) ?? null,
      prNumber: (r.pr_number as number) ?? null,
      acceptedAttemptId: (r.accepted_attempt_id as string) ?? null,
      blockedOnHuman: Boolean(r.blocked_on_human as number),
      createdAt: r.created_at as number,
      mergedAt: (r.merged_at as number) ?? null,
      closedAt: (r.closed_at as number) ?? null,
    };
  }
}
```

- [ ] **Step 3:** Run: `npx vitest run tests/topic.test.ts`. Expected: PASS.

- [ ] **Step 4:** Commit:
```bash
git add src/server/topic.ts tests/topic.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(topic): TopicStore with create/phase/find/list"
```

---

## Task 4: `Task` entity

**Files:** Create `src/server/task.ts`; create `tests/task.test.ts`.

- [ ] **Step 1:** Write failing test — create task linked to existing session row, transition states, list by topic, sort by relevance.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore } from '../src/server/repo';
import { TopicStore } from '../src/server/topic';
import { TaskStore, type TaskType } from '../src/server/task';

describe('TaskStore', () => {
  let db: Database.Database; let repoId: string; let topicId: string; let tasks: TaskStore;
  beforeEach(() => {
    db = new Database(':memory:'); ensureSchema(db);
    repoId = new RepoStore(db).register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' }).id;
    topicId = new TopicStore(db).create({ repoId, phase: 'Draft', template: 'standard', title: 'T', slug: 't' }).id;
    db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES ('s1','/tmp/r','x','running',1,1)").run();
    tasks = new TaskStore(db);
  });

  it('creates attempt task linked to session', () => {
    const t = tasks.create({ sessionId: 's1', topicId, type: 'attempt', label: 'attempt-1', childBranch: 'x__attempt-1', worktreePath: '/tmp/wt/s1' });
    expect(tasks.getBySession('s1')?.type).toBe<TaskType>('attempt');
    expect(t.label).toBe('attempt-1');
  });

  it('listByTopic orders Running > accepted > discarded > created-desc', () => {
    db.prepare("INSERT INTO sessions (id, cwd, status, created_at, last_event_at) VALUES ('s1','/tmp/r','ended',1,1)").run();
    db.prepare("INSERT INTO sessions (id, cwd, status, created_at, last_event_at) VALUES ('s2','/tmp/r','running',2,2)").run();
    db.prepare("INSERT INTO sessions (id, cwd, status, created_at, last_event_at) VALUES ('s3','/tmp/r','ended',3,3)").run();
    tasks.create({ sessionId: 's1', topicId, type: 'attempt' });
    tasks.create({ sessionId: 's2', topicId, type: 'attempt' });
    tasks.create({ sessionId: 's3', topicId, type: 'attempt' });
    tasks.markDiscarded('s1');
    tasks.markAccepted('s3');
    const ordered = tasks.listByTopic(topicId).map((t) => t.sessionId);
    expect(ordered[0]).toBe('s2'); // running first
    expect(ordered[1]).toBe('s3'); // accepted next
    expect(ordered[2]).toBe('s1'); // discarded last
  });
});
```

- [ ] **Step 2:** Create `src/server/task.ts`:

```ts
import type Database from 'better-sqlite3';

export type TaskType = 'attempt' | 'fix-comments' | 'fix-ci' | 'rebase' | 'free';
export interface TaskInput {
  sessionId: string; topicId: string; type: TaskType;
  label?: string | null; parentTrigger?: unknown;
  childBranch?: string | null; worktreePath?: string | null;
}
export interface Task {
  sessionId: string; topicId: string; type: TaskType;
  label: string | null; parentTrigger: unknown | null;
  childBranch: string | null; worktreePath: string | null;
  acceptedAt: number | null; discardedAt: number | null;
  triageResult: unknown | null; createdAt: number;
}

export class TaskStore {
  constructor(private db: Database.Database) {}
  create(i: TaskInput): Task {
    const now = Date.now();
    this.db.prepare(`INSERT INTO task (session_id, topic_id, type, label, parent_trigger, child_branch, worktree_path, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(i.sessionId, i.topicId, i.type, i.label ?? null,
           i.parentTrigger ? JSON.stringify(i.parentTrigger) : null,
           i.childBranch ?? null, i.worktreePath ?? null, now);
    return this.getBySession(i.sessionId)!;
  }
  getBySession(sessionId: string): Task | null {
    const r = this.db.prepare('SELECT * FROM task WHERE session_id=?').get(sessionId) as Record<string, unknown> | undefined;
    return r ? this.hydrate(r) : null;
  }
  listByTopic(topicId: string): Task[] {
    // Join sessions for status-based ordering.
    const rows = this.db.prepare(`
      SELECT t.*, s.status AS session_status, s.last_event_at AS last_event_at
      FROM task t JOIN sessions s ON s.id = t.session_id
      WHERE t.topic_id=?
      ORDER BY
        CASE WHEN s.status='running' THEN 0
             WHEN t.accepted_at IS NOT NULL THEN 1
             WHEN t.discarded_at IS NOT NULL THEN 3
             ELSE 2 END,
        s.last_event_at DESC
    `).all(topicId) as Record<string, unknown>[];
    return rows.map((r) => this.hydrate(r));
  }
  markAccepted(sessionId: string): void {
    this.db.prepare('UPDATE task SET accepted_at=? WHERE session_id=?').run(Date.now(), sessionId);
  }
  markDiscarded(sessionId: string): void {
    this.db.prepare('UPDATE task SET discarded_at=? WHERE session_id=?').run(Date.now(), sessionId);
  }
  setTriage(sessionId: string, triage: unknown): void {
    this.db.prepare('UPDATE task SET triage_result=? WHERE session_id=?').run(JSON.stringify(triage), sessionId);
  }
  private hydrate(r: Record<string, unknown>): Task {
    return {
      sessionId: r.session_id as string, topicId: r.topic_id as string,
      type: r.type as TaskType, label: (r.label as string) ?? null,
      parentTrigger: r.parent_trigger ? JSON.parse(r.parent_trigger as string) : null,
      childBranch: (r.child_branch as string) ?? null, worktreePath: (r.worktree_path as string) ?? null,
      acceptedAt: (r.accepted_at as number) ?? null, discardedAt: (r.discarded_at as number) ?? null,
      triageResult: r.triage_result ? JSON.parse(r.triage_result as string) : null,
      createdAt: r.created_at as number,
    };
  }
}
```

- [ ] **Step 3:** Run test. Expected: PASS.
- [ ] **Step 4:** Commit:
```bash
git add src/server/task.ts tests/task.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(task): TaskStore linking sessions to topics"
```

---

## Task 5: `VcsAdapter` interface and common types

**Files:** Create `src/server/vcs/adapter.ts`.

- [ ] **Step 1:** Create `src/server/vcs/adapter.ts`:

```ts
export interface RepoSummary {
  owner: string; name: string; defaultBranch: string;
  parentOwner?: string; parentName?: string;
}
export interface PR {
  number: number; url: string; title: string; body: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  baseBranch: string; headBranch: string;
  author: string; mergeable: boolean | null;
  approvalsCount: number; requiredApprovals: number;
}
export interface ReviewThreadComment {
  author: string; isBot: boolean; body: string; path: string | null; line: number | null;
}
export interface ReviewThread { id: string; isResolved: boolean; comments: ReviewThreadComment[]; }
export interface Check {
  name: string; status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'neutral' | null;
  runId: number; url: string; startedAt: number | null; completedAt: number | null;
}
export interface VcsAdapter {
  kind: 'github' | 'gitlab';
  getCurrentUser(): Promise<{ login: string }>;
  getRepo(cwd: string): Promise<RepoSummary>;
  createPR(input: { cwd: string; base: string; head: string; title: string; body: string }): Promise<PR>;
  getPR(cwd: string, number: number): Promise<PR>;
  mergePR(cwd: string, number: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void>;
  listReviewThreads(cwd: string, number: number): Promise<ReviewThread[]>;
  replyOnThread(cwd: string, threadId: string, body: string): Promise<void>;
  resolveThread(cwd: string, threadId: string): Promise<void>;
  listChecks(cwd: string, ref: string): Promise<Check[]>;
  getRequiredChecks(cwd: string, branch: string): Promise<string[]>;
  rerunFailedChecks(cwd: string, runId: number): Promise<void>;
  listCollaborators(cwd: string): Promise<{ login: string; name?: string }[]>;
}
```

- [ ] **Step 2:** Commit:
```bash
git add src/server/vcs/adapter.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(vcs): VcsAdapter interface and shared types"
```

---

## Task 6: `GitHubAdapter` — read-side

**Files:** Create `src/server/vcs/github.ts`, `tests/vcs-github.test.ts`, `tests/fixtures/gh-output/*.json`.

- [ ] **Step 1:** Capture real `gh` output for fixtures (one-time, documented; committed JSON):

```bash
mkdir -p tests/fixtures/gh-output
gh pr view 1 --repo cli/cli --json number,url,title,body,state,baseRefName,headRefName,author,mergeable,reviewDecision,reviewRequests > tests/fixtures/gh-output/pr-view.json
```

(If `gh` unauthenticated for testing, stub JSON by hand — shape below.)

Stub `tests/fixtures/gh-output/pr-view.json`:
```json
{"number":4711,"url":"https://github.com/acme/repo/pull/4711","title":"Fix login","body":"...","state":"OPEN","baseRefName":"main","headRefName":"jaceksan/ABC-123_fix-login","author":{"login":"jaceksan"},"mergeable":"MERGEABLE","reviewDecision":"REVIEW_REQUIRED"}
```

- [ ] **Step 2:** Write test for `GitHubAdapter.getPR`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { GitHubAdapter } from '../src/server/vcs/github';
import { readFileSync } from 'node:fs';

describe('GitHubAdapter.getPR', () => {
  it('parses gh pr view JSON', async () => {
    const stub = readFileSync('tests/fixtures/gh-output/pr-view.json', 'utf8');
    const adapter = new GitHubAdapter({ exec: async () => stub });
    const pr = await adapter.getPR('/tmp/r', 4711);
    expect(pr.number).toBe(4711);
    expect(pr.state).toBe('OPEN');
    expect(pr.headBranch).toBe('jaceksan/ABC-123_fix-login');
    expect(pr.author).toBe('jaceksan');
  });
});
```

- [ ] **Step 3:** Create `src/server/vcs/github.ts` with injectable `exec`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VcsAdapter, PR, RepoSummary, ReviewThread, Check } from './adapter';

const execFileP = promisify(execFile);

export type Exec = (file: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

const defaultExec: Exec = async (file, args, opts) => {
  const { stdout } = await execFileP(file, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

export class GitHubAdapter implements VcsAdapter {
  readonly kind = 'github' as const;
  private exec: Exec;
  constructor(opts: { exec?: Exec } = {}) { this.exec = opts.exec ?? defaultExec; }

  private async gh(args: string[], cwd?: string): Promise<string> {
    return this.exec('gh', args, { cwd });
  }

  async getCurrentUser(): Promise<{ login: string }> {
    const out = await this.gh(['api', 'user', '--jq', '.login']);
    return { login: out.trim() };
  }

  async getRepo(cwd: string): Promise<RepoSummary> {
    const out = await this.gh(['repo', 'view', '--json', 'owner,name,defaultBranchRef,parent'], cwd);
    const j = JSON.parse(out);
    return {
      owner: j.owner.login, name: j.name,
      defaultBranch: j.defaultBranchRef.name,
      parentOwner: j.parent?.owner?.login, parentName: j.parent?.name,
    };
  }

  async getPR(cwd: string, n: number): Promise<PR> {
    const out = await this.gh(['pr', 'view', String(n),
      '--json', 'number,url,title,body,state,baseRefName,headRefName,author,mergeable,reviewDecision'], cwd);
    const j = JSON.parse(out);
    return {
      number: j.number, url: j.url, title: j.title, body: j.body, state: j.state,
      baseBranch: j.baseRefName, headBranch: j.headRefName,
      author: j.author?.login ?? '', mergeable: j.mergeable === 'MERGEABLE' ? true : j.mergeable === 'CONFLICTING' ? false : null,
      approvalsCount: 0, requiredApprovals: j.reviewDecision === 'APPROVED' ? 0 : 1,
    };
  }

  async createPR(input: { cwd: string; base: string; head: string; title: string; body: string }): Promise<PR> {
    const out = await this.gh(['pr', 'create', '--base', input.base, '--head', input.head,
      '--title', input.title, '--body', input.body, '--json', 'number'], input.cwd);
    const j = JSON.parse(out);
    return this.getPR(input.cwd, j.number);
  }

  async mergePR(cwd: string, n: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void> {
    const flag = strategy === 'squash' ? '--squash' : strategy === 'rebase' ? '--rebase' : '--merge';
    await this.gh(['pr', 'merge', String(n), flag, '--delete-branch'], cwd);
  }

  async listReviewThreads(cwd: string, n: number): Promise<ReviewThread[]> {
    const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:10){nodes{body path line:originalLine author{login ... on Bot{id} ... on User{id}}}}}}}}}`;
    const repo = await this.getRepo(cwd);
    const out = await this.gh(['api', 'graphql', '-f', `query=${query}`,
      '-f', `owner=${repo.owner}`, '-f', `repo=${repo.name}`, '-F', `number=${n}`], cwd);
    const j = JSON.parse(out);
    return (j.data.repository.pullRequest.reviewThreads.nodes as any[]).map((t) => ({
      id: t.id, isResolved: t.isResolved,
      comments: (t.comments.nodes as any[]).map((c) => ({
        author: c.author?.login ?? '', isBot: !!c.author && !c.author.id, body: c.body,
        path: c.path ?? null, line: c.line ?? null,
      })),
    }));
  }

  async replyOnThread(cwd: string, threadId: string, body: string): Promise<void> {
    const mutation = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}`;
    await this.gh(['api', 'graphql', '-f', `query=${mutation}`, '-f', `threadId=${threadId}`, '-f', `body=${body}`], cwd);
  }

  async resolveThread(cwd: string, threadId: string): Promise<void> {
    const m = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}`;
    await this.gh(['api', 'graphql', '-f', `query=${m}`, '-f', `threadId=${threadId}`], cwd);
  }

  async listChecks(cwd: string, ref: string): Promise<Check[]> {
    const out = await this.gh(['api', `repos/{owner}/{repo}/commits/${ref}/check-runs`], cwd);
    const j = JSON.parse(out);
    return (j.check_runs as any[]).map((r) => ({
      name: r.name, status: r.status, conclusion: r.conclusion,
      runId: r.id, url: r.html_url,
      startedAt: r.started_at ? Date.parse(r.started_at) : null,
      completedAt: r.completed_at ? Date.parse(r.completed_at) : null,
    }));
  }

  async getRequiredChecks(cwd: string, branch: string): Promise<string[]> {
    try {
      const out = await this.gh(['api', `repos/{owner}/{repo}/branches/${branch}/protection/required_status_checks`], cwd);
      const j = JSON.parse(out);
      return j.contexts ?? [];
    } catch { return []; }
  }

  async rerunFailedChecks(cwd: string, runId: number): Promise<void> {
    await this.gh(['run', 'rerun', String(runId), '--failed'], cwd);
  }

  async listCollaborators(cwd: string): Promise<{ login: string; name?: string }[]> {
    const out = await this.gh(['api', 'repos/{owner}/{repo}/collaborators', '--paginate'], cwd);
    return (JSON.parse(out) as any[]).map((c) => ({ login: c.login, name: c.name }));
  }
}
```

- [ ] **Step 4:** Run test: `npx vitest run tests/vcs-github.test.ts`. Expected: PASS.

- [ ] **Step 5:** Add one more test per method using handwritten fixture JSON; repeat Step 2-style stub-and-assert pattern for `listReviewThreads`, `listChecks`, `getRequiredChecks`.

- [ ] **Step 6:** Commit:
```bash
git add src/server/vcs/ tests/vcs-github.test.ts tests/fixtures/gh-output/
CLAUDEX_SKIP_README=1 git commit -m "feat(vcs): GitHubAdapter over gh CLI with injectable exec"
```

---

## Task 7: `TrackerAdapter` skeleton + `NoneAdapter`

**Files:** Create `src/server/tracker/adapter.ts`, `src/server/tracker/none.ts`, `src/server/tracker/index.ts`.

- [ ] **Step 1:** Create `src/server/tracker/adapter.ts`:

```ts
export interface Ticket {
  key: string; title: string; body: string; url: string; status: string;
}
export interface TrackerAdapter {
  kind: 'jira' | 'youtrack' | 'linear' | 'none';
  whoami(): Promise<{ accountId: string; displayName: string } | null>;
  searchAssigned(): Promise<Ticket[]>;
  searchRecent(): Promise<Ticket[]>;
  getTicket(key: string): Promise<Ticket | null>;
  createTicket(input: { title: string; body: string; project?: string }): Promise<Ticket | null>;
  postComment(key: string, body: string): Promise<void>;
}
```

- [ ] **Step 2:** Create `src/server/tracker/none.ts`:

```ts
import type { TrackerAdapter } from './adapter';

export class NoneAdapter implements TrackerAdapter {
  readonly kind = 'none' as const;
  async whoami() { return null; }
  async searchAssigned() { return []; }
  async searchRecent() { return []; }
  async getTicket() { return null; }
  async createTicket() { return null; }
  async postComment() { /* noop */ }
}
```

- [ ] **Step 3:** Create `src/server/tracker/index.ts`:

```ts
import type { TrackerAdapter } from './adapter';
import { NoneAdapter } from './none';

export type TrackerKind = 'jira' | 'youtrack' | 'linear' | 'none';
export function getTrackerAdapter(kind: TrackerKind): TrackerAdapter {
  switch (kind) {
    case 'none': return new NoneAdapter();
    default:
      // Phase 5 ships jira/youtrack/linear via MCP. For now fall back to None.
      return new NoneAdapter();
  }
}
```

- [ ] **Step 4:** Commit:
```bash
git add src/server/tracker/
CLAUDEX_SKIP_README=1 git commit -m "feat(tracker): TrackerAdapter interface + NoneAdapter fallback"
```

---

## Task 8: Identity auto-wire

**Files:** Create `src/server/identity.ts`; create `tests/identity.test.ts`.

- [ ] **Step 1:** Write failing test — `getOrFetchGithubLogin(db, adapter)` returns cached value, or fetches on first call.

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { getOrFetchGithubLogin } from '../src/server/identity';

describe('identity', () => {
  it('fetches and caches github login', async () => {
    const db = new Database(':memory:'); ensureSchema(db);
    let calls = 0;
    const adapter = { getCurrentUser: async () => { calls++; return { login: 'jaceksan' }; } } as any;
    expect(await getOrFetchGithubLogin(db, adapter)).toBe('jaceksan');
    expect(await getOrFetchGithubLogin(db, adapter)).toBe('jaceksan');
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2:** Create `src/server/identity.ts`:

```ts
import type Database from 'better-sqlite3';
import type { VcsAdapter } from './vcs/adapter';

export async function getOrFetchGithubLogin(db: Database.Database, adapter: VcsAdapter): Promise<string> {
  const row = db.prepare('SELECT github_login FROM user WHERE singleton=1').get() as { github_login: string | null } | undefined;
  if (row?.github_login) return row.github_login;
  const { login } = await adapter.getCurrentUser();
  db.prepare('INSERT INTO user (singleton, github_login) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET github_login=excluded.github_login').run(login);
  return login;
}

export function setGithubLogin(db: Database.Database, login: string): void {
  db.prepare('INSERT INTO user (singleton, github_login) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET github_login=excluded.github_login').run(login);
}
```

- [ ] **Step 3:** Run test. Expected: PASS.

- [ ] **Step 4:** Commit:
```bash
git add src/server/identity.ts tests/identity.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(identity): cache github login on user singleton row"
```

---

## Task 9: Legacy-session migration

**Files:** Create `src/server/migration.ts`; create `tests/migration.test.ts`.

- [ ] **Step 1:** Write failing test — pre-existing sessions with `worktree_origin` become tasks under a synthetic `legacy` topic.

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { runMigrations } from '../src/server/migration';

describe('runMigrations', () => {
  it('creates legacy topic and tasks for existing worktree sessions', () => {
    const db = new Database(':memory:'); ensureSchema(db);
    const now = Date.now();
    db.prepare(`INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at, worktree_origin, worktree_branch)
                VALUES ('s1', '/tmp/r/wt1', 'old', 'ended', ?, ?, '/tmp/r', 'claudex/abc-123')`).run(now, now);
    db.prepare(`INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at)
                VALUES ('s2', '/tmp/other', 'no-worktree', 'ended', ?, ?)`).run(now, now);
    runMigrations(db);
    const topics = db.prepare("SELECT * FROM topic WHERE title='Legacy sessions'").all();
    expect(topics.length).toBe(1);
    const tasks = db.prepare('SELECT * FROM task').all() as Array<{ session_id: string }>;
    expect(tasks.map((t) => t.session_id)).toContain('s1');
    // s2 has no worktree; still migrated (as edit-in-place) or skipped? Skip for now to keep plan small.
    expect(tasks.map((t) => t.session_id)).not.toContain('s2');
  });

  it('is idempotent', () => {
    const db = new Database(':memory:'); ensureSchema(db);
    db.prepare(`INSERT INTO sessions (id, cwd, status, created_at, last_event_at, worktree_origin, worktree_branch)
                VALUES ('s1', '/tmp/wt', 'ended', 1, 1, '/tmp/r', 'b')`).run();
    runMigrations(db);
    runMigrations(db);
    const topics = db.prepare("SELECT COUNT(*) AS n FROM topic WHERE title='Legacy sessions'").get() as { n: number };
    expect(topics.n).toBe(1);
    const tasks = db.prepare("SELECT COUNT(*) AS n FROM task WHERE session_id='s1'").get() as { n: number };
    expect(tasks.n).toBe(1);
  });
});
```

- [ ] **Step 2:** Create `src/server/migration.ts`:

```ts
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export function runMigrations(db: Database.Database): void {
  migrateLegacyWorktreeSessions(db);
}

function migrateLegacyWorktreeSessions(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT s.id, s.worktree_origin, s.worktree_branch, s.cwd
    FROM sessions s
    LEFT JOIN task t ON t.session_id = s.id
    WHERE s.worktree_origin IS NOT NULL AND t.session_id IS NULL
  `).all() as { id: string; worktree_origin: string; worktree_branch: string | null; cwd: string }[];

  if (rows.length === 0) return;

  // Group by origin path. One legacy topic per origin.
  const byOrigin = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byOrigin.get(r.worktree_origin) ?? [];
    list.push(r);
    byOrigin.set(r.worktree_origin, list);
  }

  for (const [origin, sessionRows] of byOrigin) {
    let repo = db.prepare('SELECT id FROM repo WHERE path=?').get(origin) as { id: string } | undefined;
    if (!repo) {
      const repoId = `repo_${crypto.randomUUID().slice(0, 8)}`;
      db.prepare(`INSERT INTO repo (id, path, vcs_kind, canonical_remote, fork_remote, default_branch, created_at)
                  VALUES (?, ?, 'github', 'origin', 'origin', 'main', ?)`).run(repoId, origin, Date.now());
      repo = { id: repoId };
    }
    let topic = db.prepare("SELECT id FROM topic WHERE repo_id=? AND title='Legacy sessions'").get(repo.id) as { id: string } | undefined;
    if (!topic) {
      const topicId = `topic_${crypto.randomUUID().slice(0, 8)}`;
      db.prepare(`INSERT INTO topic (id, repo_id, phase, template, title, slug, blocked_on_human, created_at)
                  VALUES (?, ?, 'Draft', 'standard', 'Legacy sessions', 'legacy', 0, ?)`).run(topicId, repo.id, Date.now());
      topic = { id: topicId };
    }
    const insTask = db.prepare(`INSERT INTO task (session_id, topic_id, type, child_branch, worktree_path, created_at)
                                VALUES (?, ?, 'free', ?, ?, ?)`);
    for (const s of sessionRows) {
      insTask.run(s.id, topic.id, s.worktree_branch, s.cwd, Date.now());
    }
  }
}
```

- [ ] **Step 3:** Run test. Expected: PASS.

- [ ] **Step 4:** Wire into `src/server/index.ts` — on startup, after `new Db(...)` is created, call `runMigrations(db.underlying())` (add a getter that exposes the raw database for migrations only).

Add to `Db`:
```ts
underlying(): Database.Database { return this.db; }
```

And in `index.ts` near other boot code:
```ts
import { runMigrations } from './migration';
// after new Db:
runMigrations(db.underlying());
```

- [ ] **Step 5:** Run full suite: `npx vitest run`. Expected: all tests PASS.

- [ ] **Step 6:** Typecheck: `npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`. Expected: clean.

- [ ] **Step 7:** Commit:
```bash
git add src/server/migration.ts src/server/db.ts src/server/index.ts tests/migration.test.ts
CLAUDEX_SKIP_README=1 git commit -m "feat(migration): migrate legacy worktree sessions to synthetic topic/task rows"
```

---

## Task 10: Smoke-test on real data

**Files:** None; verification only.

- [ ] **Step 1:** Build + run:
```bash
cd /home/jacek/work/src/claudex
npm run build
npm start
```

- [ ] **Step 2:** Verify boot logs show migration ran once, no errors.

- [ ] **Step 3:** Query sqlite:
```bash
sqlite3 ~/.claudex.sqlite "SELECT COUNT(*) FROM repo; SELECT COUNT(*) FROM topic; SELECT COUNT(*) FROM task;"
```
Expected: numbers reflect legacy-session count.

- [ ] **Step 4:** Restart server; verify migration does not re-duplicate rows.

- [ ] **Step 5:** Verify existing UI still works (dashboard + session view). No behaviour regression.

---

## Plan 1 done when

- All new stores tested, tables populated, migration idempotent.
- `GitHubAdapter` has unit tests for every method with JSON fixtures.
- `TrackerAdapter` + `NoneAdapter` compile and are wired in.
- `getOrFetchGithubLogin` reachable from anywhere that has the adapter + db.
- No user-visible UI change; existing dashboard and session view unchanged.
- `npx vitest run` + both `tsc` invocations clean.
