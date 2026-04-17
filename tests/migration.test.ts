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
