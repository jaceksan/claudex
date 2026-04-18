import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema.js';
import { RepoStore } from '../src/server/repo.js';
import { TopicStore } from '../src/server/topic.js';
import { TaskStore } from '../src/server/task.js';
import { buildTopicDetail } from '../src/server/ws/hub.js';
import type { TopicDeps } from '../src/server/ws/hub.js';
import type { PrBundle } from '../src/server/pr-cache.js';
import type { PR, ReviewThread, Check } from '../src/server/vcs/adapter.js';

function makePR(number: number): PR {
  return {
    number, url: `https://github.com/owner/repo/pull/${number}`,
    title: 'Test PR', body: '', state: 'OPEN',
    baseBranch: 'main', headBranch: 'feat/branch',
    author: 'jaceksan', mergeable: null, approvalsCount: 0, requiredApprovals: 1,
  };
}

function makeThread(id: string): ReviewThread {
  return {
    id, isResolved: false,
    comments: [{ author: 'reviewer', isBot: false, body: 'Fix this', path: 'src/foo.ts', line: 1 }],
  };
}

function makeCheck(name: string, conclusion: Check['conclusion'] = 'success'): Check {
  return {
    name, status: 'completed', conclusion, runId: 1,
    url: `https://github.com/runs/1`, startedAt: null, completedAt: null,
  };
}

describe('buildTopicDetail', () => {
  let db: Database.Database;
  let repos: RepoStore;
  let topics: TopicStore;
  let tasks: TaskStore;

  function makeDeps(prCache?: TopicDeps['prCache']): TopicDeps {
    return {
      repos, topics, tasks, rawDb: db,
      topicManager: null as unknown as TopicDeps['topicManager'],
      prCache,
    };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    repos = new RepoStore(db);
    topics = new TopicStore(db);
    tasks = new TaskStore(db);
  });

  it('returns basic bundle for a Draft topic without PR', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin',
      forkRemote: 'origin', defaultBranch: 'main',
    });
    const topic = topics.create({
      repoId: repo.id, phase: 'Draft', template: 'standard',
      title: 'My feature', slug: 'my-feature', ticketKey: 'ABC-1', topicBranch: 'jaceksan/ABC-1_my-feature',
    });
    // Seed a session so TaskStore JOIN works
    db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,?,?,'idle',?,?)")
      .run('sess_1', '/tmp/r', 'attempt-1', Date.now(), Date.now());
    tasks.create({ sessionId: 'sess_1', topicId: topic.id, type: 'attempt', label: 'attempt-1' });

    const env = await buildTopicDetail(topic.id, makeDeps());
    expect(env.type).toBe('server.topic.detail');
    if (env.type !== 'server.topic.detail') return;

    expect(env.payload.topicId).toBe(topic.id);
    expect(env.payload.topic.phase).toBe('Draft');
    expect(env.payload.topic.title).toBe('My feature');
    expect(env.payload.tasks).toHaveLength(1);
    expect(env.payload.tasks[0].type).toBe('attempt');
    expect(env.payload.pr).toBeUndefined();
    expect(env.payload.threads).toBeUndefined();
  });

  it('includes PR bundle for Open topic when prCache is provided', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin',
      forkRemote: 'origin', defaultBranch: 'main',
    });
    const topic = topics.create({
      repoId: repo.id, phase: 'Open', template: 'standard',
      title: 'My open feature', slug: 'my-open-feature', ticketKey: 'ABC-2', topicBranch: 'jaceksan/ABC-2_my-open-feature',
    });
    topics.setPhase(topic.id, 'Open', { prNumber: 42 });

    db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,?,?,'idle',?,?)")
      .run('sess_2', '/tmp/r', 'attempt-1', Date.now(), Date.now());
    tasks.create({ sessionId: 'sess_2', topicId: topic.id, type: 'attempt', label: 'attempt-1' });

    const prBundle: PrBundle = {
      pr: makePR(42),
      threads: [makeThread('t1')],
      checks: [makeCheck('build', 'success'), makeCheck('lint', 'failure')],
      requiredContexts: ['build', 'lint'],
      fetchedAt: Date.now(),
    };

    const fakeCache: TopicDeps['prCache'] = {
      get: async () => prBundle,
      invalidate: () => {},
    } as unknown as TopicDeps['prCache'];

    const env = await buildTopicDetail(topic.id, makeDeps(fakeCache));
    expect(env.type).toBe('server.topic.detail');
    if (env.type !== 'server.topic.detail') return;

    expect(env.payload.pr?.number).toBe(42);
    expect(env.payload.threads).toHaveLength(1);
    expect(env.payload.checks).toHaveLength(2);
    expect(env.payload.required).toContain('build');
    expect(env.payload.required).toContain('lint');
  });

  it('handles missing topic gracefully', async () => {
    await expect(buildTopicDetail('no-such-id', makeDeps())).rejects.toThrow('topic no-such-id not found');
  });

  it('returns empty tasks for topic with no tasks', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin',
      forkRemote: 'origin', defaultBranch: 'main',
    });
    const topic = topics.create({
      repoId: repo.id, phase: 'Draft', template: 'standard',
      title: 'Empty topic', slug: 'empty', ticketKey: null, topicBranch: null,
    });

    const env = await buildTopicDetail(topic.id, makeDeps());
    expect(env.type).toBe('server.topic.detail');
    if (env.type !== 'server.topic.detail') return;
    expect(env.payload.tasks).toHaveLength(0);
  });
});
