import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema.js';
import { RepoStore } from '../src/server/repo.js';
import { TopicStore } from '../src/server/topic.js';
import { PrLifecycle } from '../src/server/pr-lifecycle.js';
import type { VcsAdapter, PR, ReviewThread, Check } from '../src/server/vcs/adapter.js';
import type { PrBundle } from '../src/server/pr-cache.js';

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

function makeThread(id: string, opts: { isResolved?: boolean; isBot?: boolean } = {}): ReviewThread {
  return {
    id,
    isResolved: opts.isResolved ?? false,
    comments: [
      {
        author: opts.isBot ? 'bot' : 'human',
        isBot: opts.isBot ?? false,
        body: `Comment from ${id}`,
        path: 'src/foo.ts',
        line: 10,
      },
    ],
  };
}

function makeCheck(name: string, conclusion: Check['conclusion'] = 'failure'): Check {
  return {
    name,
    status: 'completed',
    conclusion,
    runId: 12345,
    url: `https://github.com/runs/12345`,
    startedAt: null,
    completedAt: null,
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

    const fakeTopicManager = {
      addFixTask: vi.fn().mockResolvedValue({ sessionId: 'sess_fix' }),
    };

    lifecycle = new PrLifecycle({
      repos,
      topics,
      adapter: (_repoId) => fakeAdapter as VcsAdapter,
      prCache: { get: vi.fn(), invalidate: vi.fn() } as unknown as import('../src/server/pr-cache.js').PrCache,
      git: async (args, cwd) => {
        gitCalls.push({ args, cwd });
        return '';
      },
      topicManager: fakeTopicManager,
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

describe('PrLifecycle fix methods', () => {
  let db: Database.Database;
  let repos: RepoStore;
  let topics: TopicStore;
  let addFixTask: ReturnType<typeof vi.fn>;
  let mockPrCacheGet: ReturnType<typeof vi.fn>;
  let gitCalls: Array<{ args: string[]; cwd?: string }>;
  let lifecycle: PrLifecycle;

  function makeBundle(override: Partial<PrBundle> = {}): PrBundle {
    return {
      pr: makeFakePR(7),
      threads: [],
      checks: [],
      requiredContexts: [],
      fetchedAt: Date.now(),
      ...override,
    };
  }

  function makeRepo() {
    return repos.register({
      path: '/tmp/repo',
      vcsKind: 'github',
      canonicalRemote: 'origin',
      forkRemote: 'fork',
      defaultBranch: 'main',
    });
  }

  function makeOpenTopic(repoId: string) {
    const topic = topics.create({
      repoId,
      phase: 'Draft',
      template: 'standard',
      title: 'Fix task topic',
      slug: 'fix-task-topic',
      topicBranch: 'jaceksan/fix-task-topic',
    });
    topics.setPhase(topic.id, 'Open', { prNumber: 7 });
    return topics.getById(topic.id)!;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    repos = new RepoStore(db);
    topics = new TopicStore(db);
    gitCalls = [];
    addFixTask = vi.fn().mockResolvedValue({ sessionId: 'sess_fix_1' });
    mockPrCacheGet = vi.fn();

    const fakeAdapter: Partial<VcsAdapter> = { kind: 'github' };

    lifecycle = new PrLifecycle({
      repos,
      topics,
      adapter: (_repoId) => fakeAdapter as VcsAdapter,
      prCache: { get: mockPrCacheGet, invalidate: vi.fn() } as unknown as import('../src/server/pr-cache.js').PrCache,
      git: async (args, cwd) => {
        gitCalls.push({ args, cwd });
        return 'some log output';
      },
      topicManager: { addFixTask },
    });
  });

  describe('addressFeedback', () => {
    it('spawns fix-comments task when there are unresolved human threads', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      const thread = makeThread('thread-1');
      mockPrCacheGet.mockResolvedValue(
        makeBundle({ threads: [thread], requiredContexts: [] })
      );

      const result = await lifecycle.addressFeedback(topic.id, { includeCi: false, includeComments: true });

      expect(result).toEqual({ sessionId: 'sess_fix_1' });
      expect(addFixTask).toHaveBeenCalledOnce();
      const call = addFixTask.mock.calls[0];
      expect(call[0]).toBe(topic.id);
      expect(call[1].type).toBe('fix-comments');
      expect(call[1].permissionMode).toBe('acceptEdits');
      expect(call[1].parentTrigger).toEqual({
        threadIds: ['thread-1'],
        checkNames: [],
      });
    });

    it('spawns fix-ci task when there are failing required checks', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      const check = makeCheck('unit-tests');
      mockPrCacheGet.mockResolvedValue(
        makeBundle({ checks: [check], requiredContexts: ['unit-tests'] })
      );

      const result = await lifecycle.addressFeedback(topic.id, { includeCi: true, includeComments: false });

      expect(result).toEqual({ sessionId: 'sess_fix_1' });
      expect(addFixTask).toHaveBeenCalledOnce();
      const call = addFixTask.mock.calls[0];
      expect(call[1].type).toBe('fix-ci');
      expect(call[1].parentTrigger).toEqual({
        threadIds: [],
        checkNames: ['unit-tests'],
      });
      // git was called for log tail
      expect(gitCalls.some((g) => g.args.includes('--log-failed'))).toBe(true);
    });

    it('throws "nothing to address" when no threads and no failing checks', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      mockPrCacheGet.mockResolvedValue(makeBundle());

      await expect(
        lifecycle.addressFeedback(topic.id, { includeCi: true, includeComments: true })
      ).rejects.toThrow('nothing to address');
    });

    it('skips bot comments when filtering threads', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      const botThread = makeThread('bot-thread', { isBot: true });
      mockPrCacheGet.mockResolvedValue(makeBundle({ threads: [botThread] }));

      await expect(
        lifecycle.addressFeedback(topic.id, { includeCi: false, includeComments: true })
      ).rejects.toThrow('nothing to address');
    });
  });

  describe('fixComment', () => {
    it('spawns fix-comments task scoped to single thread', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      const thread = makeThread('thread-42');
      mockPrCacheGet.mockResolvedValue(makeBundle({ threads: [thread] }));

      const result = await lifecycle.fixComment(topic.id, 'thread-42');

      expect(result).toEqual({ sessionId: 'sess_fix_1' });
      expect(addFixTask).toHaveBeenCalledOnce();
      const call = addFixTask.mock.calls[0];
      expect(call[1].type).toBe('fix-comments');
      expect(call[1].parentTrigger).toEqual({ threadIds: ['thread-42'] });
    });

    it('throws when thread is not found', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      mockPrCacheGet.mockResolvedValue(makeBundle({ threads: [] }));

      await expect(lifecycle.fixComment(topic.id, 'missing-thread')).rejects.toThrow(
        'thread missing-thread not found'
      );
    });
  });

  describe('fixCheck', () => {
    it('spawns fix-ci task scoped to single check and fetches log tail', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      const check = makeCheck('e2e-tests');
      mockPrCacheGet.mockResolvedValue(makeBundle({ checks: [check] }));

      const result = await lifecycle.fixCheck(topic.id, 'e2e-tests');

      expect(result).toEqual({ sessionId: 'sess_fix_1' });
      expect(addFixTask).toHaveBeenCalledOnce();
      const call = addFixTask.mock.calls[0];
      expect(call[1].type).toBe('fix-ci');
      expect(call[1].parentTrigger).toEqual({ checkNames: ['e2e-tests'] });
      // log tail was attempted
      expect(gitCalls.some((g) => g.args.includes('--log-failed'))).toBe(true);
    });

    it('throws when check is not found', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      mockPrCacheGet.mockResolvedValue(makeBundle({ checks: [] }));

      await expect(lifecycle.fixCheck(topic.id, 'missing-check')).rejects.toThrow(
        'check missing-check not found'
      );
    });

    it('still spawns task even if log-failed fetch fails', async () => {
      const repo = makeRepo();
      const topic = makeOpenTopic(repo.id);
      const check = makeCheck('flaky-test');
      mockPrCacheGet.mockResolvedValue(makeBundle({ checks: [check] }));

      lifecycle = new PrLifecycle({
        repos,
        topics,
        adapter: () => ({ kind: 'github' } as VcsAdapter),
        prCache: { get: mockPrCacheGet, invalidate: vi.fn() } as unknown as import('../src/server/pr-cache.js').PrCache,
        git: async (args) => {
          if (args.includes('--log-failed')) throw new Error('gh error');
          return '';
        },
        topicManager: { addFixTask },
      });

      const result = await lifecycle.fixCheck(topic.id, 'flaky-test');
      expect(result).toEqual({ sessionId: 'sess_fix_1' });
      // prompt was still built with empty logTail
      const call = addFixTask.mock.calls[0];
      expect(call[1].prompt).toContain('flaky-test');
    });
  });
});
