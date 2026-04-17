import Database from 'better-sqlite3';
import { ensureSchema } from './schema.js';

export interface SessionRow {
  id: string;
  claude_session_id: string | null;
  cwd: string;
  label: string | null;
  status: string;
  created_at: number;
  ended_at: number | null;
  last_event_at: number;
  error: string | null;
  effort: string | null;
  cum_cost: number;
  cum_in: number;
  cum_out: number;
  turns: number;
  worktree_origin: string | null;
  worktree_branch: string | null;
}

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    ensureSchema(this.db);
  }

  setUsage(id: string, cumCost: number, cumIn: number, cumOut: number, turns: number): void {
    this.db.prepare('UPDATE sessions SET cum_cost=?, cum_in=?, cum_out=?, turns=? WHERE id=?')
      .run(cumCost, cumIn, cumOut, turns, id);
  }

  clearClaudeSessionId(id: string): void {
    this.db.prepare('UPDATE sessions SET claude_session_id=NULL WHERE id=?').run(id);
  }

  upsertSession(row: { id: string; claudeSessionId?: string | null; cwd: string; label: string | null; status: string; effort?: string | null; error?: string | null; worktreeOrigin?: string | null; worktreeBranch?: string | null }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sessions (id, claude_session_id, cwd, label, status, created_at, last_event_at, error, effort, worktree_origin, worktree_branch)
      VALUES (@id, @claude, @cwd, @label, @status, @now, @now, @error, COALESCE(@effort, 'medium'), @worktreeOrigin, @worktreeBranch)
      ON CONFLICT(id) DO UPDATE SET
        claude_session_id = COALESCE(excluded.claude_session_id, sessions.claude_session_id),
        status = excluded.status,
        label = COALESCE(excluded.label, sessions.label),
        last_event_at = excluded.last_event_at,
        error = COALESCE(excluded.error, sessions.error),
        effort = COALESCE(excluded.effort, sessions.effort),
        worktree_origin = COALESCE(excluded.worktree_origin, sessions.worktree_origin),
        worktree_branch = COALESCE(excluded.worktree_branch, sessions.worktree_branch),
        ended_at = CASE WHEN excluded.status IN ('ended','crashed') THEN excluded.last_event_at ELSE sessions.ended_at END
    `).run({
      id: row.id,
      claude: row.claudeSessionId ?? null,
      cwd: row.cwd,
      label: row.label,
      status: row.status,
      now,
      error: row.error ?? null,
      effort: row.effort ?? null,
      worktreeOrigin: row.worktreeOrigin ?? null,
      worktreeBranch: row.worktreeBranch ?? null,
    });
  }

  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_event_at DESC').all() as SessionRow[];
  }

  markAllDetached(): void {
    this.db.prepare(`UPDATE sessions SET status='detached' WHERE status NOT IN ('ended','crashed','detached')`).run();
  }

  setPref(key: string, value: string): void {
    this.db.prepare(`INSERT INTO prefs(key,value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }

  getPref(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM prefs WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setLabel(id: string, label: string | null): void {
    this.db.prepare('UPDATE sessions SET label=? WHERE id=?').run(label, id);
  }

  setEffort(id: string, effort: string): void {
    this.db.prepare('UPDATE sessions SET effort=? WHERE id=?').run(effort, id);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  }

  underlying(): Database.Database { return this.db; }

  close(): void {
    this.db.close();
  }
}
