import Database from 'better-sqlite3';

export interface SessionRow {
  id: string;
  cwd: string;
  label: string | null;
  status: string;
  created_at: number;
  ended_at: number | null;
  last_event_at: number;
  error: string | null;
}

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        last_event_at INTEGER NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS prefs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  upsertSession(row: { id: string; cwd: string; label: string | null; status: string; error?: string | null }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at, error)
      VALUES (@id, @cwd, @label, @status, @now, @now, @error)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        label = COALESCE(excluded.label, sessions.label),
        last_event_at = excluded.last_event_at,
        error = COALESCE(excluded.error, sessions.error),
        ended_at = CASE WHEN excluded.status IN ('ended','crashed') THEN excluded.last_event_at ELSE sessions.ended_at END
    `).run({ ...row, now, error: row.error ?? null });
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

  close(): void {
    this.db.close();
  }
}
