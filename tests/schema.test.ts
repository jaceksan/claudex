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
