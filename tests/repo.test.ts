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
