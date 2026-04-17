import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore } from '../src/server/repo';
import { TopicStore, type TopicPhase } from '../src/server/topic';

describe('TopicStore', () => {
  let db: Database.Database; let repoId: string; let topics: TopicStore;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    const repos = new RepoStore(db);
    repoId = repos.register({ path: '/tmp/r', vcsKind: 'github', canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main' }).id;
    topics = new TopicStore(db);
  });

  it('creates a Draft topic with slug and retrieves by id', () => {
    const t = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'Fix login copy', slug: 'fix-login-copy', ticketKey: 'ABC-123', topicBranch: 'jaceksan/ABC-123_fix-login-copy' });
    expect(t.id).toMatch(/^topic_/);
    expect(topics.getById(t.id)?.title).toBe('Fix login copy');
  });

  it('transitions phase and persists', () => {
    const t = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'T', slug: 't' });
    topics.setPhase(t.id, 'Open', { prNumber: 4711 });
    const t2 = topics.getById(t.id)!;
    expect(t2.phase).toBe<TopicPhase>('Open');
    expect(t2.prNumber).toBe(4711);
  });

  it('findByPrNumber returns the topic', () => {
    const t = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'T', slug: 't' });
    topics.setPhase(t.id, 'Open', { prNumber: 99 });
    expect(topics.findByPrNumber(repoId, 99)?.id).toBe(t.id);
  });

  it('listByRepo excludes Merged/Closed by default, includes when asked', () => {
    const a = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'A', slug: 'a' });
    const b = topics.create({ repoId, phase: 'Draft', template: 'standard', title: 'B', slug: 'b' });
    topics.setPhase(b.id, 'Merged');
    expect(topics.listByRepo(repoId).map((t) => t.id)).toEqual([a.id]);
    expect(topics.listByRepo(repoId, { includeArchived: true }).length).toBe(2);
  });
});
