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

  it('non-voting checks CRUD + idempotency + repo-scoped', () => {
    const a = store.register({ path: '/tmp/a', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const b = store.register({ path: '/tmp/b', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });

    // Initially empty per repo.
    expect(store.listNonVoting(a.id)).toEqual([]);
    expect(store.listNonVoting(b.id)).toEqual([]);

    // Add with and without reason; ordering is alphabetical.
    store.addNonVoting(a.id, 'sonar', 'flaky');
    store.addNonVoting(a.id, 'lint-experimental');
    expect(store.listNonVoting(a.id)).toEqual(['lint-experimental', 'sonar']);
    expect(store.listNonVoting(b.id)).toEqual([]); // scoped per repo

    const detailed = store.listNonVotingDetailed(a.id);
    expect(detailed.map((d) => d.checkName)).toEqual(['lint-experimental', 'sonar']);
    expect(detailed.find((d) => d.checkName === 'sonar')?.reason).toBe('flaky');
    expect(detailed.find((d) => d.checkName === 'lint-experimental')?.reason).toBeNull();

    // Re-adding the same name replaces (INSERT OR REPLACE) — no duplicates.
    store.addNonVoting(a.id, 'sonar', 'slow');
    const fresh = store.listNonVotingDetailed(a.id).find((d) => d.checkName === 'sonar');
    expect(fresh?.reason).toBe('slow');
    expect(store.listNonVoting(a.id)).toHaveLength(2);

    // Remove clears only the matching row.
    store.removeNonVoting(a.id, 'sonar');
    expect(store.listNonVoting(a.id)).toEqual(['lint-experimental']);
  });
});
