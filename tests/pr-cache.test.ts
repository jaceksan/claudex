import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrCache } from '../src/server/pr-cache.js';
import type { VcsAdapter, PR, ReviewThread, Check } from '../src/server/vcs/adapter.js';

function makeAdapter(): VcsAdapter & { callCount: number } {
  const pr: PR = {
    number: 42,
    url: 'https://github.com/test/repo/pull/42',
    title: 'Test PR',
    body: 'body',
    state: 'OPEN',
    baseBranch: 'main',
    headBranch: 'feature/test',
    author: 'jaceksan',
    mergeable: true,
    approvalsCount: 0,
    requiredApprovals: 1,
  };
  const threads: ReviewThread[] = [{ id: 't1', isResolved: false, comments: [] }];
  const checks: Check[] = [
    { name: 'ci', status: 'completed', conclusion: 'success', runId: 1, url: '', startedAt: null, completedAt: null },
  ];

  const adapter = {
    callCount: 0,
    kind: 'github' as const,
    getCurrentUser: async () => ({ login: 'jaceksan' }),
    getRepo: async () => ({ owner: 'test', name: 'repo', defaultBranch: 'main' }),
    createPR: async () => pr,
    getPR: async (_cwd: string, _number: number) => { adapter.callCount++; return pr; },
    mergePR: async () => {},
    listReviewThreads: async () => threads,
    replyOnThread: async () => {},
    resolveThread: async () => {},
    listChecks: async () => checks,
    getRequiredChecks: async () => ['ci'],
    rerunFailedChecks: async () => {},
    listCollaborators: async () => [],
  };
  return adapter;
}

describe('PrCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a bundle on first call and adapter is called once', async () => {
    const adapter = makeAdapter();
    const cache = new PrCache(adapter, 30_000);

    const bundle = await cache.get('/repo', 42, 'main');

    expect(bundle.pr.number).toBe(42);
    expect(bundle.threads).toHaveLength(1);
    expect(bundle.checks).toHaveLength(1);
    expect(bundle.requiredContexts).toEqual(['ci']);
    expect(bundle.fetchedAt).toBeGreaterThan(0);
    expect(adapter.callCount).toBe(1);
  });

  it('returns cached value within TTL (adapter called only once for two gets)', async () => {
    const adapter = makeAdapter();
    const cache = new PrCache(adapter, 30_000);

    await cache.get('/repo', 42, 'main');
    vi.advanceTimersByTime(10_000); // advance 10s, still within 30s TTL
    await cache.get('/repo', 42, 'main');

    expect(adapter.callCount).toBe(1);
  });

  it('refetches after TTL expires', async () => {
    const adapter = makeAdapter();
    const cache = new PrCache(adapter, 30_000);

    await cache.get('/repo', 42, 'main');
    vi.advanceTimersByTime(31_000); // advance past TTL
    await cache.get('/repo', 42, 'main');

    expect(adapter.callCount).toBe(2);
  });

  it('force=true bypasses cache within TTL', async () => {
    const adapter = makeAdapter();
    const cache = new PrCache(adapter, 30_000);

    await cache.get('/repo', 42, 'main');
    vi.advanceTimersByTime(5_000);
    await cache.get('/repo', 42, 'main', true);

    expect(adapter.callCount).toBe(2);
  });

  it('invalidate forces refetch on next get', async () => {
    const adapter = makeAdapter();
    const cache = new PrCache(adapter, 30_000);

    await cache.get('/repo', 42, 'main');
    cache.invalidate('/repo', 42);
    await cache.get('/repo', 42, 'main');

    expect(adapter.callCount).toBe(2);
  });

  it('uses separate keys for different cwd or prNumber', async () => {
    const adapter = makeAdapter();
    const cache = new PrCache(adapter, 30_000);

    await cache.get('/repo-a', 42, 'main');
    await cache.get('/repo-b', 42, 'main');
    await cache.get('/repo-a', 99, 'main');

    expect(adapter.callCount).toBe(3);
  });
});
