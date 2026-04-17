import type Database from 'better-sqlite3';

export function ensureSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS repo (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      vcs_kind TEXT NOT NULL,
      canonical_remote TEXT NOT NULL,
      fork_remote TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      canonical_owner TEXT,
      canonical_name TEXT,
      fork_owner TEXT,
      fork_name TEXT,
      tracker_mcp TEXT,
      branch_template TEXT NOT NULL DEFAULT '{gh_user}/{ticket}_{slug}',
      commit_template TEXT NOT NULL DEFAULT '{subject}',
      attempt_suffix TEXT NOT NULL DEFAULT '__attempt-{n}',
      validate_cmd TEXT,
      pr_body_template TEXT,
      merge_strategy TEXT NOT NULL DEFAULT 'squash',
      required_checks_cache TEXT,
      required_checks_cache_at INTEGER,
      non_voting_overrides TEXT NOT NULL DEFAULT '[]',
      flaky_patterns TEXT NOT NULL DEFAULT '[]',
      flaky_tests TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '{}',
      known_types TEXT NOT NULL DEFAULT '[]',
      known_projects TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topic (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      template TEXT NOT NULL,
      ticket_key TEXT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      topic_branch TEXT,
      pr_number INTEGER,
      accepted_attempt_id TEXT,
      blocked_on_human INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      merged_at INTEGER,
      closed_at INTEGER,
      FOREIGN KEY (repo_id) REFERENCES repo(id)
    );
    CREATE TABLE IF NOT EXISTS task (
      session_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      parent_trigger TEXT,
      child_branch TEXT,
      worktree_path TEXT,
      accepted_at INTEGER,
      discarded_at INTEGER,
      triage_result TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES topic(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      github_login TEXT,
      preferred_template TEXT NOT NULL DEFAULT 'standard'
    );
    CREATE INDEX IF NOT EXISTS idx_topic_repo ON topic(repo_id);
    CREATE INDEX IF NOT EXISTS idx_task_topic ON task(topic_id);
  `);

  const sessionCols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  const addCol = (col: string, ddl: string) => {
    if (!sessionCols.includes(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
  };
  addCol('claude_session_id', 'claude_session_id TEXT');
  addCol('effort', "effort TEXT NOT NULL DEFAULT 'medium'");
  addCol('cum_cost', 'cum_cost REAL NOT NULL DEFAULT 0');
  addCol('cum_in', 'cum_in INTEGER NOT NULL DEFAULT 0');
  addCol('cum_out', 'cum_out INTEGER NOT NULL DEFAULT 0');
  addCol('turns', 'turns INTEGER NOT NULL DEFAULT 0');
  addCol('worktree_origin', 'worktree_origin TEXT');
  addCol('worktree_branch', 'worktree_branch TEXT');
}
