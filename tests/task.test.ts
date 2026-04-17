import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore } from '../src/server/repo';
import { TopicStore } from '../src/server/topic';
import { TaskStore, type TaskType } from '../src/server/task';

describe('TaskStore', () => {
  let db: Database.Database; let repoId: string; let topicId: string; let tasks: TaskStore;
  beforeEach(() => {
    db = new Database(':memory:'); ensureSchema(db);
    repoId = new RepoStore(db).register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' }).id;
    topicId = new TopicStore(db).create({ repoId, phase: 'Draft', template: 'standard', title: 'T', slug: 't' }).id;
    db.prepare("INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at) VALUES ('s1','/tmp/r','x','running',1,1)").run();
    tasks = new TaskStore(db);
  });

  it('creates attempt task linked to session', () => {
    const t = tasks.create({ sessionId: 's1', topicId, type: 'attempt', label: 'attempt-1', childBranch: 'x__attempt-1', worktreePath: '/tmp/wt/s1' });
    expect(tasks.getBySession('s1')?.type).toBe<TaskType>('attempt');
    expect(t.label).toBe('attempt-1');
  });

  it('listByTopic orders Running > accepted > discarded > created-desc', () => {
    db.prepare("INSERT OR REPLACE INTO sessions (id, cwd, status, created_at, last_event_at) VALUES ('s1','/tmp/r','ended',1,1)").run();
    db.prepare("INSERT OR REPLACE INTO sessions (id, cwd, status, created_at, last_event_at) VALUES ('s2','/tmp/r','running',2,2)").run();
    db.prepare("INSERT OR REPLACE INTO sessions (id, cwd, status, created_at, last_event_at) VALUES ('s3','/tmp/r','ended',3,3)").run();
    tasks.create({ sessionId: 's1', topicId, type: 'attempt' });
    tasks.create({ sessionId: 's2', topicId, type: 'attempt' });
    tasks.create({ sessionId: 's3', topicId, type: 'attempt' });
    tasks.markDiscarded('s1');
    tasks.markAccepted('s3');
    const ordered = tasks.listByTopic(topicId).map((t) => t.sessionId);
    expect(ordered[0]).toBe('s2'); // running first
    expect(ordered[1]).toBe('s3'); // accepted next
    expect(ordered[2]).toBe('s1'); // discarded last
  });

  it('markAccepted throws on unknown sessionId', () => {
    expect(() => tasks.markAccepted('no-such-session')).toThrow('task no-such-session not found');
  });

  it('markDiscarded throws on unknown sessionId', () => {
    expect(() => tasks.markDiscarded('no-such-session')).toThrow('task no-such-session not found');
  });

  it('setTriage throws on unknown sessionId', () => {
    expect(() => tasks.setTriage('no-such-session', { result: 'ok' })).toThrow('task no-such-session not found');
  });
});
