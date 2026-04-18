import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema.js';
import { RepoStore } from '../src/server/repo.js';
import { TopicStore } from '../src/server/topic.js';
import { PrLifecycle } from '../src/server/pr-lifecycle.js';
import type { VcsAdapter, PR } from '../src/server/vcs/adapter.js';
import type { PrCache } from '../src/server/pr-cache.js';

function makeFakePR(number: number): PR {
  return {
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    title: 'Test PR',
    body: '',
    state: 'OPEN',
    baseBranch: 'main',
    headBranch: 'feat/branch',
    author: 'jaceksan',
    mergeable: null,
    approvalsCount: 0,
    requiredApprovals: 1,
  };
}

describe('PrLifecycle.createPR', () => {
  let db: Database.Database;
  let repos: RepoStore;
  let topics: TopicStore;
  let gitCalls: Array<{ args: string[]; cwd?: string }>;
  let mockCreatePR: ReturnType<typeof vi.fn>;
  let lifecycle: PrLifecycle;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    repos = new RepoStore(db);
    topics = new TopicStore(db);
    gitCalls = [];

    mockCreatePR = vi.fn().mockResolvedValue(makeFakePR(42));

    const fakeAdapter: Partial<VcsAdapter> = {
      kind: 'github',
      createPR: mockCreatePR,
    };

    const fakePrCache = {} as PrCache;

    lifecycle = new PrLifecycle({
      repos,
      topics,
      adapter: (_repoId) => fakeAdapter as VcsAdapter,
      prCache: fakePrCache,
      git: async (args, cwd) => {
        gitCalls.push({ args, cwd });
        return '';
      },
    });
  });

  it('happy path: pushes to fork remote, calls adapter.createPR, sets phase Open with prNumber, returns number', async () => {
    const repo = repos.register({
      path: '/tmp/repo',
      vcsKind: 'github',
      canonicalRemote: 'origin',
      forkRemote: 'fork',
      defaultBranch: 'main',
    });
    const topic = topics.create({
      repoId: repo.id,
      phase: 'Draft',
      template: 'standard',
      title: 'My feature',
      slug: 'my-feature',
      ticketKey: 'ABC-1',
      topicBranch: 'jaceksan/ABC-1_my-feature',
    });

    const result = await lifecycle.createPR(topic.id, {});

    // push was called with fork remote and topic branch
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0].args).toEqual(['push', 'fork', 'jaceksan/ABC-1_my-feature']);
    expect(gitCalls[0].cwd).toBe('/tmp/repo');

    // adapter.createPR was called with correct params
    expect(mockCreatePR).toHaveBeenCalledOnce();
    expect(mockCreatePR).toHaveBeenCalledWith({
      cwd: '/tmp/repo',
      base: 'main',
      head: 'jaceksan/ABC-1_my-feature',
      title: 'ABC-1: My feature',
      body: expect.stringContaining('## Summary'),
    });

    // phase set to Open with prNumber
    const updated = topics.getById(topic.id)!;
    expect(updated.phase).toBe('Open');
    expect(updated.prNumber).toBe(42);

    // returns pr number
    expect(result).toBe(42);
  });

  it('throws when topic has no branch', async () => {
    const repo = repos.register({
      path: '/tmp/repo',
      vcsKind: 'github',
      canonicalRemote: 'origin',
      forkRemote: 'fork',
      defaultBranch: 'main',
    });
    const topic = topics.create({
      repoId: repo.id,
      phase: 'Draft',
      template: 'exploration',
      title: 'Explore something',
      slug: 'explore-something',
      topicBranch: null,
    });

    await expect(lifecycle.createPR(topic.id, {})).rejects.toThrow('topic has no branch');
  });

  it('throws when phase is not Draft', async () => {
    const repo = repos.register({
      path: '/tmp/repo',
      vcsKind: 'github',
      canonicalRemote: 'origin',
      forkRemote: 'fork',
      defaultBranch: 'main',
    });
    const topic = topics.create({
      repoId: repo.id,
      phase: 'Open',
      template: 'standard',
      title: 'Already open',
      slug: 'already-open',
      topicBranch: 'jaceksan/already-open',
    });

    await expect(lifecycle.createPR(topic.id, {})).rejects.toThrow('cannot create PR in phase Open');
  });

  it('throws when topic is not found', async () => {
    await expect(lifecycle.createPR('topic_nonexistent', {})).rejects.toThrow('topic not found');
  });
});
