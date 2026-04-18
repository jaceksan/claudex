import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore } from '../src/server/repo';
import { TopicStore } from '../src/server/topic';
import { TaskStore } from '../src/server/task';
import { TopicManager } from '../src/server/topic-manager';

describe('TopicManager.create', () => {
  let db: Database.Database; let repos: RepoStore; let topics: TopicStore; let tasks: TaskStore;
  let gitCalls: Array<{ args: string[]; cwd?: string }>;
  let mgr: TopicManager;

  beforeEach(() => {
    db = new Database(':memory:'); ensureSchema(db);
    repos = new RepoStore(db); topics = new TopicStore(db); tasks = new TaskStore(db);
    gitCalls = [];
    let n = 0;
    mgr = new TopicManager({
      db, repos, topics, tasks,
      git: async (args, cwd) => { gitCalls.push({ args, cwd }); return ''; },
      createWorktree: (cwd, id, opts) => ({ path: `/tmp/wt/${id}`, origin: cwd, branch: opts.branch }),
      spawnSession: async ({ cwd, label }) => {
        const id = `sess_${++n}`;
        db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,?,?,'running',?,?)")
          .run(id, cwd, label ?? null, Date.now(), Date.now());
        return { id };
      },
      now: () => 1700000000000,
      githubLogin: async () => 'jaceksan',
    });
  });

  it('creates Draft topic with branch but NO attempt when template=standard', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'Fix login copy', ticketKey: 'ABC-123',
    });
    expect(topic.phase).toBe('Draft');
    expect(topic.topicBranch).toBe('jaceksan/ABC-123_fix-login-copy');
    expect(gitCalls.map((c) => c.args[0])).toContain('fetch');
    expect(gitCalls.map((c) => c.args[0])).toContain('branch');
    expect(tasks.listByTopic(topic.id)).toHaveLength(0);
  });

  it('creates Exploring topic with no branch and NO task when template=exploration', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'exploration',
      title: 'Explore refactor',
    });
    expect(topic.phase).toBe('Exploring');
    expect(topic.topicBranch).toBeNull();
    expect(tasks.listByTopic(topic.id)).toHaveLength(0);
  });

  it('throws when repoId does not resolve', async () => {
    await expect(mgr.create({
      repoId: 'repo_zzzz', template: 'standard', title: 'x',
    })).rejects.toThrow(/not found/);
  });

  it('addAttempt creates attempt-1 branch when topic has no attempts yet', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature', ticketKey: 'XY-1',
    });
    const task1 = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    expect(task1.type).toBe('attempt');
    expect(task1.childBranch).toMatch(/__attempt-1$/);
    const task2 = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    expect(task2.childBranch).toMatch(/__attempt-2$/);
  });

  it('acceptAttempt squash-merges, marks accepted, discards siblings', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature', ticketKey: 'XY-1',
    });
    const task1 = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    const task2 = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });

    gitCalls.length = 0; // reset to capture only acceptAttempt calls
    await mgr.acceptAttempt(task1.sessionId);

    const gitArgSets = gitCalls.map((c) => c.args);
    expect(gitArgSets).toContainEqual(['checkout', topic.topicBranch]);
    expect(gitArgSets).toContainEqual(['merge', '--squash', task1.childBranch]);
    expect(gitArgSets).toContainEqual(['commit', '-m', 'XY-1: My feature']);

    const updatedTopic = topics.getById(topic.id)!;
    expect(updatedTopic.acceptedAttemptId).toBe(task1.sessionId);

    const t1After = tasks.getBySession(task1.sessionId)!;
    expect(t1After.acceptedAt).not.toBeNull();

    const t2After = tasks.getBySession(task2.sessionId)!;
    expect(t2After.discardedAt).not.toBeNull();
  });

  it('discardAttempt marks attempt discarded', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature',
    });
    const task = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    await mgr.discardAttempt(task.sessionId);
    const after = tasks.getBySession(task.sessionId)!;
    expect(after.discardedAt).not.toBeNull();
  });

  it('addAttempt throws after accept', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature',
    });
    const task = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    await mgr.acceptAttempt(task.sessionId);
    await expect(mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' }))
      .rejects.toThrow(/cannot add attempt after accept/);
  });

  it('acceptAttempt throws on missing session', async () => {
    await expect(mgr.acceptAttempt('sess_nope')).rejects.toThrow(/not found/);
  });

  it('deleteTopic cascades: kills sessions, drops branch, removes topic + task rows', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const killed: string[] = [];
    mgr = new TopicManager({
      db, repos, topics, tasks,
      git: async (args, cwd) => { gitCalls.push({ args, cwd }); return ''; },
      createWorktree: (cwd, id, opts) => ({ path: `/tmp/wt/${id}`, origin: cwd, branch: opts.branch }),
      spawnSession: async ({ cwd, label }) => {
        const id = `sess_${Math.random().toString(36).slice(2, 8)}`;
        db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,?,?,'running',?,?)")
          .run(id, cwd, label ?? null, Date.now(), Date.now());
        return { id };
      },
      deleteSession: (id) => { killed.push(id); },
      now: () => 1700000000000,
      githubLogin: async () => 'jaceksan',
    });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'to be deleted', ticketKey: 'DEL-1',
    });
    const t1 = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    const t2 = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });

    gitCalls.length = 0;
    await mgr.deleteTopic(topic.id);

    expect(killed).toEqual(expect.arrayContaining([t1.sessionId, t2.sessionId]));
    expect(gitCalls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(true);
    expect(topics.getById(topic.id)).toBeNull();
    expect(tasks.listByTopic(topic.id)).toHaveLength(0);
  });

  it('deleteTopic throws when topic is missing', async () => {
    await expect(mgr.deleteTopic('topic_missing')).rejects.toThrow(/not found/);
  });
});

describe('TopicManager.addFixTask', () => {
  let db: Database.Database; let repos: RepoStore; let topics: TopicStore; let tasks: TaskStore;
  let mgr: TopicManager;
  let sessionCounter: number;

  function makeRepo() {
    return repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
  }

  beforeEach(() => {
    db = new Database(':memory:'); ensureSchema(db);
    repos = new RepoStore(db); topics = new TopicStore(db); tasks = new TaskStore(db);
    sessionCounter = 0;
    mgr = new TopicManager({
      db, repos, topics, tasks,
      git: async () => '',
      createWorktree: (_cwd, id, opts) => ({ path: `/tmp/wt/${id}`, origin: '/tmp/r', branch: opts.branch }),
      spawnSession: async ({ cwd, label, prompt }) => {
        const id = `sess_${++sessionCounter}`;
        db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,?,?,'running',?,?)")
          .run(id, cwd, label ?? null, Date.now(), Date.now());
        return { id };
      },
      now: () => 1700000000000,
      githubLogin: async () => 'jaceksan',
    });
  });

  async function createOpenTopic() {
    const repo = makeRepo();
    // Create a Draft topic, add an attempt, accept it — simulates Open state after PR opened.
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature', ticketKey: 'T-1',
    });
    const task = await mgr.addAttempt(topic.id, { prompt: 'start', effort: 'medium', permissionMode: 'acceptEdits' });
    db.prepare("UPDATE sessions SET status='idle' WHERE id=?").run(task.sessionId);
    await mgr.acceptAttempt(task.sessionId);
    // Force topic to Open phase (as would happen when PR is opened).
    db.prepare("UPDATE topic SET phase='Open' WHERE id=?").run(topic.id);
    const updatedTopic = topics.getById(topic.id)!;
    return { repo, topic: updatedTopic, attemptTask: task };
  }

  it('throws when topic is in an invalid phase (e.g. Merged)', async () => {
    const repo = makeRepo();
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature',
    });
    db.prepare("UPDATE topic SET phase='Merged' WHERE id=?").run(topic.id);
    await expect(mgr.addFixTask(topic.id, {
      type: 'fix-comments', prompt: 'fix it', effort: 'low', permissionMode: 'acceptEdits',
    })).rejects.toThrow(/cannot add fix task in phase Merged/);
  });

  it('throws when topic is Draft without an accepted attempt', async () => {
    const repo = makeRepo();
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature',
    });
    // Topic is Draft with no accepted attempt.
    await expect(mgr.addFixTask(topic.id, {
      type: 'fix-comments', prompt: 'fix it', effort: 'low', permissionMode: 'acceptEdits',
    })).rejects.toThrow(/cannot add fix task in phase Draft/);
  });

  it('happy path on Open phase: spawns session, creates worktree, updates cwd, creates task row', async () => {
    const { topic } = await createOpenTopic();
    const fixTask = await mgr.addFixTask(topic.id, {
      type: 'fix-comments', prompt: 'address review', effort: 'low', permissionMode: 'acceptEdits',
      label: 'review-fix', parentTrigger: { threadIds: ['t1'] },
    });

    expect(fixTask.type).toBe('fix-comments');
    expect(fixTask.topicId).toBe(topic.id);
    expect(fixTask.label).toBe('review-fix');
    expect(fixTask.childBranch).toMatch(/^.*__fix-/);
    expect(fixTask.worktreePath).toMatch(/^\/tmp\/wt\//);
    expect(fixTask.parentTrigger).toEqual({ threadIds: ['t1'] });

    // Verify the session's cwd was updated to worktree path.
    const row = db.prepare('SELECT cwd FROM sessions WHERE id=?').get(fixTask.sessionId) as { cwd: string };
    expect(row.cwd).toBe(fixTask.worktreePath);
  });

  it('happy path on Draft phase with accepted attempt', async () => {
    const repo = makeRepo();
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature', ticketKey: 'T-2',
    });
    const task = await mgr.addAttempt(topic.id, { prompt: 'start', effort: 'medium', permissionMode: 'acceptEdits' });
    db.prepare("UPDATE sessions SET status='idle' WHERE id=?").run(task.sessionId);
    await mgr.acceptAttempt(task.sessionId);
    const updatedTopic = topics.getById(topic.id)!;
    expect(updatedTopic.acceptedAttemptId).toBeTruthy();

    const fixTask = await mgr.addFixTask(topic.id, {
      type: 'fix-ci', prompt: 'fix CI', effort: 'low', permissionMode: 'acceptEdits',
    });
    expect(fixTask.type).toBe('fix-ci');
    expect(fixTask.childBranch).toContain('__fix-');
  });

  it('concurrency guard: throws if another fix-* task is running for the same topic', async () => {
    const { topic } = await createOpenTopic();

    // Create first fix task (session stays 'running').
    await mgr.addFixTask(topic.id, {
      type: 'fix-comments', prompt: 'first fix', effort: 'low', permissionMode: 'acceptEdits',
    });

    // Attempt to create a second fix task while the first session is still running.
    await expect(mgr.addFixTask(topic.id, {
      type: 'fix-ci', prompt: 'second fix', effort: 'low', permissionMode: 'acceptEdits',
    })).rejects.toThrow(/another task.*is already running/);
  });

  it('concurrency guard: allows fix task when prior fix task session is idle (not running)', async () => {
    const { topic } = await createOpenTopic();

    const firstFix = await mgr.addFixTask(topic.id, {
      type: 'fix-comments', prompt: 'first fix', effort: 'low', permissionMode: 'acceptEdits',
    });
    // Mark the session as idle/done.
    db.prepare("UPDATE sessions SET status='idle' WHERE id=?").run(firstFix.sessionId);

    // Now another fix task should be allowed.
    const secondFix = await mgr.addFixTask(topic.id, {
      type: 'fix-ci', prompt: 'second fix', effort: 'low', permissionMode: 'acceptEdits',
    });
    expect(secondFix.type).toBe('fix-ci');
  });

  it('concurrency guard: throws if a running attempt task exists for the topic', async () => {
    const repo = makeRepo();
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature',
    });
    await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    // Force topic to Open phase with acceptedAttemptId set (fake it).
    db.prepare("UPDATE topic SET phase='Open', accepted_attempt_id='fake' WHERE id=?").run(topic.id);
    const updatedTopic = topics.getById(topic.id)!;

    // The attempt session is still 'running' — guard should trigger.
    await expect(mgr.addFixTask(updatedTopic.id, {
      type: 'fix-comments', prompt: 'fix', effort: 'low', permissionMode: 'acceptEdits',
    })).rejects.toThrow(/another task.*is already running/);
  });
});

describe('TopicManager.acceptFixTask / discardFixTask', () => {
  let db: Database.Database; let repos: RepoStore; let topics: TopicStore; let tasks: TaskStore;
  let gitCalls: Array<{ args: string[]; cwd?: string }>;
  let gitReturnValue: string;
  let onFixAccepted: ReturnType<typeof vi.fn>;
  let mgr: TopicManager;
  let sessionCounter: number;

  function makeRepo() {
    return repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'fork',
      defaultBranch: 'main',
    });
  }

  beforeEach(() => {
    db = new Database(':memory:'); ensureSchema(db);
    repos = new RepoStore(db); topics = new TopicStore(db); tasks = new TaskStore(db);
    gitCalls = [];
    gitReturnValue = 'abc1234';
    onFixAccepted = vi.fn().mockResolvedValue(undefined);
    sessionCounter = 0;
    mgr = new TopicManager({
      db, repos, topics, tasks,
      git: async (args, cwd) => { gitCalls.push({ args, cwd }); return gitReturnValue; },
      createWorktree: (_cwd, id, opts) => ({ path: `/tmp/wt/${id}`, origin: '/tmp/r', branch: opts.branch }),
      spawnSession: async ({ cwd, label }) => {
        const id = `sess_${++sessionCounter}`;
        db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,?,?,'running',?,?)")
          .run(id, cwd, label ?? null, Date.now(), Date.now());
        return { id };
      },
      now: () => 1700000000000,
      githubLogin: async () => 'jaceksan',
      prLifecycle: { onFixAccepted },
    });
  });

  async function createOpenTopicWithFixTask() {
    const repo = makeRepo();
    // create Draft topic + attempt
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature', ticketKey: 'T-1',
    });
    const attemptTask = await mgr.addAttempt(topic.id, { prompt: 'start', effort: 'medium', permissionMode: 'acceptEdits' });
    db.prepare("UPDATE sessions SET status='idle' WHERE id=?").run(attemptTask.sessionId);
    await mgr.acceptAttempt(attemptTask.sessionId);
    db.prepare("UPDATE topic SET phase='Open' WHERE id=?").run(topic.id);
    const openTopic = topics.getById(topic.id)!;

    // create a fix task
    const fixTask = await mgr.addFixTask(openTopic.id, {
      type: 'fix-comments', prompt: 'address review', effort: 'low', permissionMode: 'acceptEdits',
      label: 'review-fix', parentTrigger: { threadIds: ['thread-1', 'thread-2'] },
    });
    return { repo, topic: openTopic, fixTask };
  }

  it('acceptFixTask: happy path — checkout+merge+commit+push, calls onFixAccepted, marks task accepted', async () => {
    const { topic, fixTask } = await createOpenTopicWithFixTask();
    gitCalls.length = 0; // reset to capture only acceptFixTask calls

    await mgr.acceptFixTask(fixTask.sessionId);

    const gitArgSets = gitCalls.map((c) => c.args);
    expect(gitArgSets).toContainEqual(['checkout', topic.topicBranch]);
    expect(gitArgSets).toContainEqual(['merge', '--squash', fixTask.childBranch]);
    expect(gitArgSets.some((a) => a[0] === 'commit')).toBe(true);
    expect(gitArgSets).toContainEqual(['push', 'fork', topic.topicBranch]);
    expect(gitArgSets).toContainEqual(['rev-parse', 'HEAD']);

    expect(onFixAccepted).toHaveBeenCalledOnce();
    const [calledTopic, calledTask, calledSha] = onFixAccepted.mock.calls[0];
    expect(calledTopic.id).toBe(topic.id);
    expect(calledTask.sessionId).toBe(fixTask.sessionId);
    expect(calledSha).toBe('abc1234');

    const updated = tasks.getBySession(fixTask.sessionId)!;
    expect(updated.acceptedAt).not.toBeNull();
  });

  it('acceptFixTask: throws when task not found', async () => {
    await expect(mgr.acceptFixTask('no-such-session')).rejects.toThrow(/not found/);
  });

  it('acceptFixTask: throws when task already accepted', async () => {
    const { fixTask } = await createOpenTopicWithFixTask();
    await mgr.acceptFixTask(fixTask.sessionId);
    await expect(mgr.acceptFixTask(fixTask.sessionId)).rejects.toThrow(/already accepted/);
  });

  it('acceptFixTask: throws when task type is attempt', async () => {
    const repo = makeRepo();
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'feat',
    });
    const task = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    await expect(mgr.acceptFixTask(task.sessionId)).rejects.toThrow(/not a fix task/);
  });

  it('discardFixTask: marks task discarded, no push', async () => {
    const { fixTask } = await createOpenTopicWithFixTask();
    gitCalls.length = 0;

    await mgr.discardFixTask(fixTask.sessionId);

    const updated = tasks.getBySession(fixTask.sessionId)!;
    expect(updated.discardedAt).not.toBeNull();
    expect(gitCalls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('discardFixTask: throws on non-fix-task', async () => {
    const repo = makeRepo();
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'feat',
    });
    const task = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    await expect(mgr.discardFixTask(task.sessionId)).rejects.toThrow(/not a fix task/);
  });
});
