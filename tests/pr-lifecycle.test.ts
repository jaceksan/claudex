import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema.js';
import { RepoStore } from '../src/server/repo.js';
import { TopicStore } from '../src/server/topic.js';
import { PrLifecycle, ciRollup } from '../src/server/pr-lifecycle.js';
import type { CiNotifier } from '../src/server/pr-lifecycle.js';
import type { VcsAdapter, PR, ReviewThread, Check } from '../src/server/vcs/adapter.js';
import type { Task } from '../src/server/task.js';
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

    const emptyBundle: PrBundle = {
      pr: makeFakePR(42), threads: [], checks: [], requiredContexts: [], fetchedAt: Date.now(),
    };

    lifecycle = new PrLifecycle({
      repos,
      topics,
      adapter: (_repoId) => fakeAdapter as VcsAdapter,
      prCache: { get: vi.fn().mockResolvedValue(emptyBundle), invalidate: vi.fn() } as unknown as import('../src/server/pr-cache.js').PrCache,
      git: async (args, cwd) => {
        gitCalls.push({ args, cwd });
        return '';
      },
      topicManager: fakeTopicManager,
      // No-op timers so no real intervals leak from the auto-watch in createPR.
      setInterval: (() => 0 as unknown as ReturnType<typeof setInterval>),
      clearInterval: (() => {}),
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
      // Log tail is now fetched via a direct `gh run view --log-failed` shell
      // call (see fixCheck), not via the git helper — so there's no mockable
      // side effect to assert here without shelling out. We settle for:
      // "task got spawned with the right shape" above.
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

describe('PrLifecycle.onFixAccepted', () => {
  let db: Database.Database;
  let repos: RepoStore;
  let topics: TopicStore;
  let mockInvalidate: ReturnType<typeof vi.fn>;
  let mockReplyOnThread: ReturnType<typeof vi.fn>;
  let mockResolveThread: ReturnType<typeof vi.fn>;
  let lifecycle: PrLifecycle;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    repos = new RepoStore(db);
    topics = new TopicStore(db);

    mockInvalidate = vi.fn();
    mockReplyOnThread = vi.fn().mockResolvedValue(undefined);
    mockResolveThread = vi.fn().mockResolvedValue(undefined);

    const fakeAdapter: Partial<VcsAdapter> = {
      kind: 'github',
      replyOnThread: mockReplyOnThread,
      resolveThread: mockResolveThread,
    };

    lifecycle = new PrLifecycle({
      repos,
      topics,
      adapter: (_repoId) => fakeAdapter as VcsAdapter,
      prCache: { get: vi.fn(), invalidate: mockInvalidate } as unknown as import('../src/server/pr-cache.js').PrCache,
      git: async () => '',
      topicManager: { addFixTask: vi.fn() },
    });
  });

  function makeOpenTopic(repoId: string, prNumber = 42) {
    const topic = topics.create({
      repoId,
      phase: 'Draft',
      template: 'standard',
      title: 'My feature',
      slug: 'my-feature',
      topicBranch: 'jaceksan/T-1_my-feature',
    });
    topics.setPhase(topic.id, 'Open', { prNumber });
    return topics.getById(topic.id)!;
  }

  function makeFixTask(opts: { threadIds?: string[] } = {}): Task {
    return {
      sessionId: 'sess_fix_1',
      topicId: 'topic_abc',
      type: 'fix-comments',
      label: 'review-fix',
      parentTrigger: opts.threadIds ? { threadIds: opts.threadIds } : null,
      childBranch: 'jaceksan/T-1_my-feature__fix-abc123',
      worktreePath: '/tmp/wt/sess_fix_1',
      acceptedAt: null,
      discardedAt: null,
      triageResult: null,
      createdAt: Date.now(),
    };
  }

  it('invalidates pr cache and calls replyOnThread + resolveThread for each threadId', async () => {
    const repo = repos.register({
      path: '/tmp/repo', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main',
    });
    const topic = makeOpenTopic(repo.id, 42);
    const task = makeFixTask({ threadIds: ['thread-1', 'thread-2'] });

    await lifecycle.onFixAccepted(topic, task, 'deadbeef');

    expect(mockInvalidate).toHaveBeenCalledWith('/tmp/repo', 42);
    expect(mockReplyOnThread).toHaveBeenCalledTimes(2);
    expect(mockReplyOnThread).toHaveBeenCalledWith('/tmp/repo', 'thread-1', 'Fixed in deadbeef');
    expect(mockReplyOnThread).toHaveBeenCalledWith('/tmp/repo', 'thread-2', 'Fixed in deadbeef');
    expect(mockResolveThread).toHaveBeenCalledTimes(2);
    expect(mockResolveThread).toHaveBeenCalledWith('/tmp/repo', 'thread-1');
    expect(mockResolveThread).toHaveBeenCalledWith('/tmp/repo', 'thread-2');
  });

  it('does not call reply/resolve when parentTrigger has no threadIds', async () => {
    const repo = repos.register({
      path: '/tmp/repo', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main',
    });
    const topic = makeOpenTopic(repo.id, 42);
    const task = makeFixTask(); // no threadIds

    await lifecycle.onFixAccepted(topic, task, 'deadbeef');

    expect(mockInvalidate).toHaveBeenCalledWith('/tmp/repo', 42);
    expect(mockReplyOnThread).not.toHaveBeenCalled();
    expect(mockResolveThread).not.toHaveBeenCalled();
  });

  it('swallows errors from replyOnThread and still calls resolveThread', async () => {
    const repo = repos.register({
      path: '/tmp/repo', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main',
    });
    const topic = makeOpenTopic(repo.id, 42);
    const task = makeFixTask({ threadIds: ['thread-1'] });
    mockReplyOnThread.mockRejectedValueOnce(new Error('network error'));

    // Should not throw
    await expect(lifecycle.onFixAccepted(topic, task, 'deadbeef')).resolves.toBeUndefined();
    expect(mockResolveThread).toHaveBeenCalledWith('/tmp/repo', 'thread-1');
  });

  it('does not call invalidate when topic has no prNumber', async () => {
    const repo = repos.register({
      path: '/tmp/repo', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main',
    });
    const topic = topics.create({
      repoId: repo.id, phase: 'Draft', template: 'standard',
      title: 'No PR', slug: 'no-pr', topicBranch: 'jaceksan/no-pr',
    });
    const task = makeFixTask();

    await lifecycle.onFixAccepted(topic, task, 'deadbeef');

    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CI rollup helper
// ---------------------------------------------------------------------------
describe('ciRollup', () => {
  function makeBundle(checks: Check[], requiredContexts: string[]): PrBundle {
    return {
      pr: makeFakePR(1),
      threads: [],
      checks,
      requiredContexts,
      fetchedAt: Date.now(),
    };
  }

  it('returns running when no required checks exist', () => {
    expect(ciRollup(makeBundle([], []))).toBe('running');
  });

  it('returns running when required checks have no result yet', () => {
    const c: Check = { name: 'ci', status: 'in_progress', conclusion: null, runId: 1, url: '', startedAt: null, completedAt: null };
    expect(ciRollup(makeBundle([c], ['ci']))).toBe('running');
  });

  it('returns failed when any required check failed', () => {
    const ok: Check = { name: 'lint', status: 'completed', conclusion: 'success', runId: 1, url: '', startedAt: null, completedAt: null };
    const fail: Check = { name: 'tests', status: 'completed', conclusion: 'failure', runId: 2, url: '', startedAt: null, completedAt: null };
    expect(ciRollup(makeBundle([ok, fail], ['lint', 'tests']))).toBe('failed');
  });

  it('returns ok when all required checks passed', () => {
    const c: Check = { name: 'ci', status: 'completed', conclusion: 'success', runId: 1, url: '', startedAt: null, completedAt: null };
    expect(ciRollup(makeBundle([c], ['ci']))).toBe('ok');
  });

  it('ignores non-required checks', () => {
    const required: Check = { name: 'ci', status: 'completed', conclusion: 'success', runId: 1, url: '', startedAt: null, completedAt: null };
    const nonRequired: Check = { name: 'e2e', status: 'completed', conclusion: 'failure', runId: 2, url: '', startedAt: null, completedAt: null };
    expect(ciRollup(makeBundle([required, nonRequired], ['ci']))).toBe('ok');
  });

  it('treats a suppressed failing required check as ok', () => {
    const pass: Check = { name: 'ci', status: 'completed', conclusion: 'success', runId: 1, url: '', startedAt: null, completedAt: null };
    const flaky: Check = { name: 'sonar', status: 'completed', conclusion: 'failure', runId: 2, url: '', startedAt: null, completedAt: null };
    // Both are required at the branch-protection level, but the user has
    // marked `sonar` non-voting for this repo — rollup must ignore it.
    expect(ciRollup(makeBundle([pass, flaky], ['ci', 'sonar']), ['sonar'])).toBe('ok');
    // Without the override it's failing — confirms the filter is doing the work.
    expect(ciRollup(makeBundle([pass, flaky], ['ci', 'sonar']))).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// CI watch — poll + notifications
// ---------------------------------------------------------------------------
describe('PrLifecycle CI watch', () => {
  let db: Database.Database;
  let repos: RepoStore;
  let topics: TopicStore;
  let notifier: CiNotifier & { calls: Array<{ prev: string; curr: string }> };

  function makeBundle(checks: Array<{ name: string; conclusion: Check['conclusion'] }>, required: string[]): PrBundle {
    return {
      pr: makeFakePR(99),
      threads: [],
      checks: checks.map(({ name, conclusion }) => ({
        name, conclusion, status: 'completed', runId: 1, url: '', startedAt: null, completedAt: null,
      })),
      requiredContexts: required,
      fetchedAt: Date.now(),
    };
  }

  function makeLifecycle(prCacheGet: ReturnType<typeof vi.fn>) {
    return new PrLifecycle({
      repos,
      topics,
      adapter: () => ({ kind: 'github' } as VcsAdapter),
      prCache: { get: prCacheGet, invalidate: vi.fn() } as unknown as import('../src/server/pr-cache.js').PrCache,
      git: async () => '',
      topicManager: { addFixTask: vi.fn().mockResolvedValue({ sessionId: 'x' }) },
      notifications: notifier,
      // Use no-op setInterval/clearInterval to avoid leaking real timers in tests.
      setInterval: (() => 0 as unknown as ReturnType<typeof setInterval>),
      clearInterval: (() => {}),
    });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    repos = new RepoStore(db);
    topics = new TopicStore(db);

    const _calls: Array<{ prev: string; curr: string }> = [];
    notifier = {
      calls: _calls,
      ciStateChanged(_topic, prev, curr) { _calls.push({ prev, curr }); },
    };
  });

  function makeOpenTopic(repoId: string) {
    const t = topics.create({
      repoId, phase: 'Draft', template: 'standard',
      title: 'Watch topic', slug: 'watch-topic',
      topicBranch: 'jaceksan/watch-topic',
    });
    topics.setPhase(t.id, 'Open', { prNumber: 99 });
    return topics.getById(t.id)!;
  }

  it('persists watch_ci=1 when enabling', async () => {
    const repo = repos.register({ path: '/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main' });
    const topic = makeOpenTopic(repo.id);
    const prCacheGet = vi.fn().mockResolvedValue(makeBundle([{ name: 'ci', conclusion: 'success' }], ['ci']));
    const lifecycle = makeLifecycle(prCacheGet);

    await lifecycle.watchCi(topic.id, true);

    expect(topics.getById(topic.id)!.watchCi).toBe(true);
  });

  it('persists watch_ci=0 when disabling', async () => {
    const repo = repos.register({ path: '/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main' });
    const topic = makeOpenTopic(repo.id);
    const prCacheGet = vi.fn().mockResolvedValue(makeBundle([], []));
    const lifecycle = makeLifecycle(prCacheGet);

    await lifecycle.watchCi(topic.id, true);
    await lifecycle.watchCi(topic.id, false);

    expect(topics.getById(topic.id)!.watchCi).toBe(false);
  });

  it('does NOT fire notification on first poll (no prev state)', async () => {
    const repo = repos.register({ path: '/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main' });
    const topic = makeOpenTopic(repo.id);
    const prCacheGet = vi.fn().mockResolvedValue(makeBundle([{ name: 'ci', conclusion: 'success' }], ['ci']));
    const lifecycle = makeLifecycle(prCacheGet);

    await lifecycle.watchCi(topic.id, true);

    expect(notifier.calls).toHaveLength(0);
  });

  it('fires notification on running→ok transition via _pollCi', async () => {
    const repo = repos.register({ path: '/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main' });
    const topic = makeOpenTopic(repo.id);

    // Alternate bundles: first call = running, second call = ok
    const prCacheGet = vi.fn()
      .mockResolvedValueOnce(makeBundle([{ name: 'ci', conclusion: null }], ['ci']))   // running
      .mockResolvedValueOnce(makeBundle([{ name: 'ci', conclusion: 'success' }], ['ci'])); // ok

    const lifecycle = makeLifecycle(prCacheGet);

    let prevState: import('../src/server/notifications.js').CiRollupState | null = null;

    // First poll — establishes baseline (running), no notification
    await lifecycle._pollCi(topic.id, '/r', 99, 'main', prevState, (s) => { prevState = s; });
    expect(notifier.calls).toHaveLength(0);

    // Second poll — transitions running→ok, should notify
    await lifecycle._pollCi(topic.id, '/r', 99, 'main', prevState, (s) => { prevState = s; });
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]).toEqual({ prev: 'running', curr: 'ok' });
  });

  it('fires notification on running→failed transition via _pollCi', async () => {
    const repo = repos.register({ path: '/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main' });
    const topic = makeOpenTopic(repo.id);

    const prCacheGet = vi.fn()
      .mockResolvedValueOnce(makeBundle([{ name: 'ci', conclusion: null }], ['ci']))    // running
      .mockResolvedValueOnce(makeBundle([{ name: 'ci', conclusion: 'failure' }], ['ci'])); // failed

    const lifecycle = makeLifecycle(prCacheGet);
    let prevState: import('../src/server/notifications.js').CiRollupState | null = null;

    await lifecycle._pollCi(topic.id, '/r', 99, 'main', prevState, (s) => { prevState = s; });
    await lifecycle._pollCi(topic.id, '/r', 99, 'main', prevState, (s) => { prevState = s; });

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]).toEqual({ prev: 'running', curr: 'failed' });
  });

  it('does not fire notification when state stays the same', async () => {
    const repo = repos.register({ path: '/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main' });
    const topic = makeOpenTopic(repo.id);

    const runningBundle = makeBundle([{ name: 'ci', conclusion: null }], ['ci']);
    const prCacheGet = vi.fn().mockResolvedValue(runningBundle);

    const lifecycle = makeLifecycle(prCacheGet);
    let prevState: import('../src/server/notifications.js').CiRollupState | null = null;

    await lifecycle._pollCi(topic.id, '/r', 99, 'main', prevState, (s) => { prevState = s; });
    await lifecycle._pollCi(topic.id, '/r', 99, 'main', prevState, (s) => { prevState = s; });

    expect(notifier.calls).toHaveLength(0);
  });

  it('stopWatch clears the pending timeout and removes from map', async () => {
    const repo = repos.register({ path: '/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main' });
    const topic = makeOpenTopic(repo.id);

    const cleared: unknown[] = [];
    const lifecycle = new PrLifecycle({
      repos, topics,
      adapter: () => ({ kind: 'github' } as VcsAdapter),
      prCache: {
        get: vi.fn().mockResolvedValue(makeBundle([], [])),
        invalidate: vi.fn(),
      } as unknown as import('../src/server/pr-cache.js').PrCache,
      git: async () => '',
      topicManager: { addFixTask: vi.fn().mockResolvedValue({ sessionId: 'x' }) },
      notifications: notifier,
      setTimeout: (() => 99 as unknown as ReturnType<typeof setTimeout>),
      clearTimeout: ((h) => cleared.push(h)),
    });

    await lifecycle.watchCi(topic.id, true);
    lifecycle.stopWatch(topic.id);

    expect(cleared).toContain(99);
    // Calling stopWatch again is a no-op — no double-clear
    lifecycle.stopWatch(topic.id);
    expect(cleared).toHaveLength(1);
  });

  it('does not double-register a watcher if watchCi called twice', async () => {
    const repo = repos.register({ path: '/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork', defaultBranch: 'main' });
    const topic = makeOpenTopic(repo.id);

    let setTimeoutCalls = 0;
    const lifecycle = new PrLifecycle({
      repos, topics,
      adapter: () => ({ kind: 'github' } as VcsAdapter),
      prCache: {
        get: vi.fn().mockResolvedValue(makeBundle([], [])),
        invalidate: vi.fn(),
      } as unknown as import('../src/server/pr-cache.js').PrCache,
      git: async () => '',
      topicManager: { addFixTask: vi.fn().mockResolvedValue({ sessionId: 'x' }) },
      notifications: notifier,
      setTimeout: (() => { setTimeoutCalls++; return setTimeoutCalls as unknown as ReturnType<typeof setTimeout>; }),
      clearTimeout: (() => {}),
    });

    await lifecycle.watchCi(topic.id, true);
    await lifecycle.watchCi(topic.id, true); // second enable — should be a no-op

    // One tick fires each watchCi, and only the first schedules a follow-up
    // (the second is a no-op because the poller map already has an entry).
    expect(setTimeoutCalls).toBe(1);
  });
});
