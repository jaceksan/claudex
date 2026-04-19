import type Database from 'better-sqlite3';

export type TaskType = 'attempt' | 'fix-comments' | 'fix-ci' | 'rebase' | 'free' | 'delivery';
export interface TaskInput {
  sessionId: string; topicId: string; type: TaskType;
  label?: string | null; parentTrigger?: unknown;
  childBranch?: string | null; worktreePath?: string | null;
}
export interface Task {
  sessionId: string; topicId: string; type: TaskType;
  label: string | null; parentTrigger: unknown | null;
  childBranch: string | null; worktreePath: string | null;
  acceptedAt: number | null; discardedAt: number | null;
  triageResult: unknown | null; createdAt: number;
}

export class TaskStore {
  constructor(private db: Database.Database) {}
  create(i: TaskInput): Task {
    const now = Date.now();
    this.db.prepare(`INSERT INTO task (session_id, topic_id, type, label, parent_trigger, child_branch, worktree_path, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(i.sessionId, i.topicId, i.type, i.label ?? null,
           i.parentTrigger ? JSON.stringify(i.parentTrigger) : null,
           i.childBranch ?? null, i.worktreePath ?? null, now);
    return this.getBySession(i.sessionId)!;
  }
  getBySession(sessionId: string): Task | null {
    const r = this.db.prepare('SELECT * FROM task WHERE session_id=?').get(sessionId) as Record<string, unknown> | undefined;
    return r ? this.hydrate(r) : null;
  }
  listByTopic(topicId: string): Task[] {
    // Join sessions for status-based ordering.
    const rows = this.db.prepare(`
      SELECT t.*, s.status AS session_status, s.last_event_at AS last_event_at
      FROM task t JOIN sessions s ON s.id = t.session_id
      WHERE t.topic_id=?
      ORDER BY
        CASE WHEN s.status='running' THEN 0
             WHEN t.accepted_at IS NOT NULL THEN 1
             WHEN t.discarded_at IS NOT NULL THEN 3
             ELSE 2 END,
        s.last_event_at DESC
    `).all(topicId) as Record<string, unknown>[];
    return rows.map((r) => this.hydrate(r));
  }
  markAccepted(sessionId: string): void {
    const info = this.db.prepare('UPDATE task SET accepted_at=? WHERE session_id=?').run(Date.now(), sessionId);
    if (info.changes === 0) throw new Error(`task ${sessionId} not found`);
  }
  markDiscarded(sessionId: string): void {
    const info = this.db.prepare('UPDATE task SET discarded_at=? WHERE session_id=?').run(Date.now(), sessionId);
    if (info.changes === 0) throw new Error(`task ${sessionId} not found`);
  }
  setTriage(sessionId: string, triage: unknown): void {
    const info = this.db.prepare('UPDATE task SET triage_result=? WHERE session_id=?').run(JSON.stringify(triage), sessionId);
    if (info.changes === 0) throw new Error(`task ${sessionId} not found`);
  }
  /** Return tasks for a topic whose session is currently running and not yet accepted/discarded. */
  listRunningByTopic(topicId: string): Task[] {
    const rows = this.db.prepare(`
      SELECT t.* FROM task t
      JOIN sessions s ON s.id = t.session_id
      WHERE t.topic_id=?
        AND s.status='running'
        AND t.accepted_at IS NULL
        AND t.discarded_at IS NULL
    `).all(topicId) as Record<string, unknown>[];
    return rows.map((r) => this.hydrate(r));
  }
  private hydrate(r: Record<string, unknown>): Task {
    return {
      sessionId: r.session_id as string, topicId: r.topic_id as string,
      type: r.type as TaskType, label: (r.label as string) ?? null,
      parentTrigger: r.parent_trigger ? JSON.parse(r.parent_trigger as string) : null,
      childBranch: (r.child_branch as string) ?? null, worktreePath: (r.worktree_path as string) ?? null,
      acceptedAt: (r.accepted_at as number) ?? null, discardedAt: (r.discarded_at as number) ?? null,
      triageResult: r.triage_result ? JSON.parse(r.triage_result as string) : null,
      createdAt: r.created_at as number,
    };
  }
}
