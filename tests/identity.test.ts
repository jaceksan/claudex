import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { getOrFetchGithubLogin } from '../src/server/identity';

describe('identity', () => {
  it('fetches and caches github login', async () => {
    const db = new Database(':memory:'); ensureSchema(db);
    let calls = 0;
    const adapter = {
      kind: 'github' as const,
      getCurrentUser: async () => { calls++; return { login: 'jaceksan' }; },
    } as unknown as import('../src/server/vcs/adapter').VcsAdapter;
    expect(await getOrFetchGithubLogin(db, adapter)).toBe('jaceksan');
    expect(await getOrFetchGithubLogin(db, adapter)).toBe('jaceksan');
    expect(calls).toBe(1);
  });
});
