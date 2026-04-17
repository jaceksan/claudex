import { describe, it, expect, beforeEach } from 'vitest';
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

  it('creates Draft topic with attempt-1 when template=standard', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic, task } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'Fix login copy', ticketKey: 'ABC-123',
      firstTask: { prompt: 'start', effort: 'medium', permissionMode: 'acceptEdits' },
    });
    expect(topic.phase).toBe('Draft');
    expect(topic.topicBranch).toBe('jaceksan/ABC-123_fix-login-copy');
    expect(task.type).toBe('attempt');
    expect(task.childBranch).toBe('jaceksan/ABC-123_fix-login-copy__attempt-1');
    expect(gitCalls.map((c) => c.args[0])).toContain('fetch');
    expect(gitCalls.map((c) => c.args[0])).toContain('branch');
  });

  it('creates Exploring topic with no branch/worktree when template=exploration', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const { topic, task } = await mgr.create({
      repoId: repo.id, template: 'exploration',
      title: 'Explore refactor',
      firstTask: { effort: 'medium', permissionMode: 'plan' },
    });
    expect(topic.phase).toBe('Exploring');
    expect(topic.topicBranch).toBeNull();
    expect(task.childBranch).toBeNull();
    expect(task.worktreePath).toBeNull();
  });

  it('throws when repoId does not resolve', async () => {
    await expect(mgr.create({
      repoId: 'repo_zzzz', template: 'standard', title: 'x',
      firstTask: { effort: 'medium', permissionMode: 'acceptEdits' },
    })).rejects.toThrow(/not found/);
  });

  it('addAttempt creates a second attempt-2 child branch', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature', ticketKey: 'XY-1',
      firstTask: { effort: 'medium', permissionMode: 'acceptEdits' },
    });
    const task2 = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    expect(task2.type).toBe('attempt');
    expect(task2.childBranch).toMatch(/__attempt-2$/);
    expect(task2.worktreePath).toBeTruthy();
  });

  it('acceptAttempt squash-merges, marks accepted, discards siblings', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic, task: task1 } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature', ticketKey: 'XY-1',
      firstTask: { effort: 'medium', permissionMode: 'acceptEdits' },
    });
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
    const { task } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature',
      firstTask: { effort: 'medium', permissionMode: 'acceptEdits' },
    });
    await mgr.discardAttempt(task.sessionId);
    const after = tasks.getBySession(task.sessionId)!;
    expect(after.discardedAt).not.toBeNull();
  });

  it('addAttempt throws after accept', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic, task } = await mgr.create({
      repoId: repo.id, template: 'standard',
      title: 'My feature',
      firstTask: { effort: 'medium', permissionMode: 'acceptEdits' },
    });
    await mgr.acceptAttempt(task.sessionId);
    await expect(mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' }))
      .rejects.toThrow(/cannot add attempt after accept/);
  });

  it('acceptAttempt throws on non-attempt task', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'exploration',
      title: 'Explore stuff',
      firstTask: { effort: 'medium', permissionMode: 'plan' },
    });
    const freeTasks = tasks.listByTopic(topic.id);
    expect(freeTasks[0].type).toBe('free');
    await expect(mgr.acceptAttempt(freeTasks[0].sessionId)).rejects.toThrow(/not an attempt task/);
  });
});
