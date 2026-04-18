import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema.js';
import { RepoStore } from '../src/server/repo.js';
import { TopicStore } from '../src/server/topic.js';
import { TaskStore } from '../src/server/task.js';
import { onSessionEnded } from '../src/server/quick-fix-auto.js';

function makeDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

function insertSession(db: Database.Database, id: string) {
  db.prepare(
    "INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES (?,'/tmp','test','ended',?,?)"
  ).run(id, Date.now(), Date.now());
}

describe('onSessionEnded', () => {
  let db: Database.Database;
  let repos: RepoStore;
  let topics: TopicStore;
  let tasks: TaskStore;
  let acceptAttempt: ReturnType<typeof vi.fn>;
  let createPR: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeDb();
    repos = new RepoStore(db);
    topics = new TopicStore(db);
    tasks = new TaskStore(db);
    acceptAttempt = vi.fn().mockResolvedValue(undefined);
    createPR = vi.fn().mockResolvedValue(42);
  });

  function makeDeps() {
    return { tasks, topics, acceptAttempt, createPR };
  }

  it('calls acceptAttempt + createPR for a quick-fix attempt on success', async () => {
    const repo = repos.register({
      path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin',
      defaultBranch: 'main',
    });
    const topic = topics.create({
      repoId: repo.id, phase: 'Draft', template: 'quick-fix',
      title: 'Fix login', slug: 'fix-login', topicBranch: 'fix/login',
    });
    const sessionId = 'sess-qf-1';
    insertSession(db, sessionId);
    tasks.create({ sessionId, topicId: topic.id, type: 'attempt', label: 'attempt-1' });

    await onSessionEnded(sessionId, 'ended', makeDeps());

    expect(acceptAttempt).toHaveBeenCalledOnce();
    expect(acceptAttempt).toHaveBeenCalledWith(sessionId);
    expect(createPR).toHaveBeenCalledOnce();
    expect(createPR).toHaveBeenCalledWith(topic.id, expect.any(Object));
  });

  it('skips when status is crashed', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const topic = topics.create({ repoId: repo.id, phase: 'Draft', template: 'quick-fix', title: 'Fix', slug: 'fix', topicBranch: 'fix/x' });
    const sessionId = 'sess-crash-1';
    insertSession(db, sessionId);
    tasks.create({ sessionId, topicId: topic.id, type: 'attempt', label: 'attempt-1' });

    await onSessionEnded(sessionId, 'crashed', makeDeps());

    expect(acceptAttempt).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
  });

  it('skips when task is not an attempt', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const topic = topics.create({ repoId: repo.id, phase: 'Draft', template: 'quick-fix', title: 'Fix', slug: 'fix', topicBranch: 'fix/x' });
    const sessionId = 'sess-fix-1';
    insertSession(db, sessionId);
    tasks.create({ sessionId, topicId: topic.id, type: 'fix-comments', label: 'fix-1' });

    await onSessionEnded(sessionId, 'ended', makeDeps());

    expect(acceptAttempt).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
  });

  it('skips when template is not quick-fix', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const topic = topics.create({ repoId: repo.id, phase: 'Draft', template: 'standard', title: 'Fix', slug: 'fix', topicBranch: 'fix/x' });
    const sessionId = 'sess-std-1';
    insertSession(db, sessionId);
    tasks.create({ sessionId, topicId: topic.id, type: 'attempt', label: 'attempt-1' });

    await onSessionEnded(sessionId, 'ended', makeDeps());

    expect(acceptAttempt).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
  });

  it('skips when task already accepted', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const topic = topics.create({ repoId: repo.id, phase: 'Draft', template: 'quick-fix', title: 'Fix', slug: 'fix', topicBranch: 'fix/x' });
    const sessionId = 'sess-acc-1';
    insertSession(db, sessionId);
    tasks.create({ sessionId, topicId: topic.id, type: 'attempt', label: 'attempt-1' });
    tasks.markAccepted(sessionId);

    await onSessionEnded(sessionId, 'ended', makeDeps());

    expect(acceptAttempt).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
  });

  it('logs error and does not throw if acceptAttempt fails', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const topic = topics.create({ repoId: repo.id, phase: 'Draft', template: 'quick-fix', title: 'Fix', slug: 'fix', topicBranch: 'fix/x' });
    const sessionId = 'sess-err-1';
    insertSession(db, sessionId);
    tasks.create({ sessionId, topicId: topic.id, type: 'attempt', label: 'attempt-1' });

    acceptAttempt.mockRejectedValue(new Error('git fail'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(onSessionEnded(sessionId, 'ended', makeDeps())).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('acceptAttempt'), expect.any(Error));
    expect(createPR).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('logs error and does not throw if createPR fails', async () => {
    const repo = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' });
    const topic = topics.create({ repoId: repo.id, phase: 'Draft', template: 'quick-fix', title: 'Fix', slug: 'fix', topicBranch: 'fix/x' });
    const sessionId = 'sess-err-2';
    insertSession(db, sessionId);
    tasks.create({ sessionId, topicId: topic.id, type: 'attempt', label: 'attempt-1' });

    createPR.mockRejectedValue(new Error('PR fail'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(onSessionEnded(sessionId, 'ended', makeDeps())).resolves.toBeUndefined();

    expect(acceptAttempt).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('createPR'), expect.any(Error));
    consoleError.mockRestore();
  });

  it('skips when no task found for sessionId', async () => {
    await onSessionEnded('nonexistent-session', 'ended', makeDeps());
    expect(acceptAttempt).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
  });
});
