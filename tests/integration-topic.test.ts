// tests/integration-topic.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore } from '../src/server/repo';
import { TopicStore } from '../src/server/topic';
import { TaskStore } from '../src/server/task';
import { TopicManager } from '../src/server/topic-manager';

describe('TopicManager end-to-end (stubbed git/spawn/worktree)', () => {
  it('creates a topic, adds a second attempt, accepts it', async () => {
    const db = new Database(':memory:'); ensureSchema(db);
    const repos = new RepoStore(db); const topics = new TopicStore(db); const tasks = new TaskStore(db);
    const gitCalls: string[][] = [];
    let n = 0;
    const mgr = new TopicManager({
      db, repos, topics, tasks,
      git: async (args) => { gitCalls.push(args); return ''; },
      createWorktree: (cwd, id, opts) => ({ path: `/tmp/wt/${id}`, origin: cwd, branch: opts.branch }),
      spawnSession: async ({ cwd, label }) => {
        const id = `sess_${++n}`;
        db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,?,?,'running',?,?)")
          .run(id, cwd, label ?? null, Date.now(), Date.now());
        return { id };
      },
      now: () => Date.now(),
      githubLogin: async () => 'jaceksan',
    });

    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const { topic } = await mgr.create({
      repoId: repo.id, template: 'standard', title: 'Fix X', ticketKey: 'ABC-1',
    });
    expect(topic.phase).toBe('Draft');

    const task = await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    await mgr.addAttempt(topic.id, { effort: 'medium', permissionMode: 'acceptEdits' });
    const tasksOnTopic = tasks.listByTopic(topic.id);
    expect(tasksOnTopic.filter((t) => t.type === 'attempt')).toHaveLength(2);

    await mgr.acceptAttempt(task.sessionId);
    const refreshed = topics.getById(topic.id)!;
    expect(refreshed.acceptedAttemptId).toBe(task.sessionId);

    // Sibling attempt-2 should now be discarded.
    const attempts = tasks.listByTopic(topic.id).filter((t) => t.type === 'attempt');
    expect(attempts.filter((t) => t.discardedAt).length).toBe(1);
  });
});
