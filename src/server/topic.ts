import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export type TopicPhase = 'Exploring' | 'Draft' | 'Open' | 'Merged' | 'Closed';
export type TopicTemplate = 'quick-fix' | 'standard' | 'exploration';

export interface TopicInput {
  repoId: string;
  phase: TopicPhase;
  template: TopicTemplate;
  title: string;
  slug: string;
  ticketKey?: string | null;
  topicBranch?: string | null;
}
export interface Topic {
  id: string; repoId: string; phase: TopicPhase; template: TopicTemplate;
  ticketKey: string | null; title: string; slug: string;
  topicBranch: string | null; prNumber: number | null;
  acceptedAttemptId: string | null; blockedOnHuman: boolean;
  watchCi: boolean;
  createdAt: number; mergedAt: number | null; closedAt: number | null;
}

export class TopicStore {
  constructor(private db: Database.Database) {}
  create(i: TopicInput): Topic {
    const id = `topic_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(`INSERT INTO topic (id, repo_id, phase, template, ticket_key, title, slug, topic_branch, blocked_on_human, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(id, i.repoId, i.phase, i.template, i.ticketKey ?? null, i.title, i.slug, i.topicBranch ?? null, now);
    return this.getById(id)!;
  }
  getById(id: string): Topic | null {
    const r = this.db.prepare('SELECT * FROM topic WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? this.hydrate(r) : null;
  }
  findByPrNumber(repoId: string, prNumber: number): Topic | null {
    const r = this.db.prepare('SELECT * FROM topic WHERE repo_id=? AND pr_number=?').get(repoId, prNumber) as Record<string, unknown> | undefined;
    return r ? this.hydrate(r) : null;
  }
  listByRepo(repoId: string, opts: { includeArchived?: boolean } = {}): Topic[] {
    const sql = opts.includeArchived
      ? 'SELECT * FROM topic WHERE repo_id=? ORDER BY created_at DESC'
      : "SELECT * FROM topic WHERE repo_id=? AND phase NOT IN ('Merged','Closed') ORDER BY created_at DESC";
    return (this.db.prepare(sql).all(repoId) as Record<string, unknown>[]).map((r) => this.hydrate(r));
  }
  setPhase(id: string, phase: TopicPhase, extra: { prNumber?: number; acceptedAttemptId?: string; topicBranch?: string } = {}): void {
    const now = Date.now();
    const parts: string[] = ['phase=?']; const args: unknown[] = [phase];
    if (extra.prNumber !== undefined) { parts.push('pr_number=?'); args.push(extra.prNumber); }
    if (extra.acceptedAttemptId !== undefined) { parts.push('accepted_attempt_id=?'); args.push(extra.acceptedAttemptId); }
    if (extra.topicBranch !== undefined) { parts.push('topic_branch=?'); args.push(extra.topicBranch); }
    if (phase === 'Merged') { parts.push('merged_at=COALESCE(merged_at, ?)'); args.push(now); }
    if (phase === 'Closed') { parts.push('closed_at=COALESCE(closed_at, ?)'); args.push(now); }
    args.push(id);
    const info = this.db.prepare(`UPDATE topic SET ${parts.join(', ')} WHERE id=?`).run(...args);
    if (info.changes === 0) throw new Error(`topic ${id} not found`);
  }
  setBlockedOnHuman(id: string, blocked: boolean): void {
    const info = this.db.prepare('UPDATE topic SET blocked_on_human=? WHERE id=?').run(blocked ? 1 : 0, id);
    if (info.changes === 0) throw new Error(`topic ${id} not found`);
  }
  setWatchCi(id: string, enabled: boolean): void {
    const info = this.db.prepare('UPDATE topic SET watch_ci=? WHERE id=?').run(enabled ? 1 : 0, id);
    if (info.changes === 0) throw new Error(`topic ${id} not found`);
  }
  private hydrate(r: Record<string, unknown>): Topic {
    return {
      id: r.id as string, repoId: r.repo_id as string,
      phase: r.phase as TopicPhase, template: r.template as TopicTemplate,
      ticketKey: (r.ticket_key as string) ?? null,
      title: r.title as string, slug: r.slug as string,
      topicBranch: (r.topic_branch as string) ?? null,
      prNumber: (r.pr_number as number) ?? null,
      acceptedAttemptId: (r.accepted_attempt_id as string) ?? null,
      blockedOnHuman: Boolean(r.blocked_on_human as number),
      watchCi: Boolean(r.watch_ci as number),
      createdAt: r.created_at as number,
      mergedAt: (r.merged_at as number) ?? null,
      closedAt: (r.closed_at as number) ?? null,
    };
  }
}
