import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export function runMigrations(db: Database.Database): void {
  migrateLegacyWorktreeSessions(db);
}

function migrateLegacyWorktreeSessions(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT s.id, s.worktree_origin, s.worktree_branch, s.cwd
    FROM sessions s
    LEFT JOIN task t ON t.session_id = s.id
    WHERE s.worktree_origin IS NOT NULL AND t.session_id IS NULL
  `).all() as { id: string; worktree_origin: string; worktree_branch: string | null; cwd: string }[];

  if (rows.length === 0) return;

  // Group by origin path. One legacy topic per origin.
  const byOrigin = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byOrigin.get(r.worktree_origin) ?? [];
    list.push(r);
    byOrigin.set(r.worktree_origin, list);
  }

  for (const [origin, sessionRows] of byOrigin) {
    let repo = db.prepare('SELECT id FROM repo WHERE path=?').get(origin) as { id: string } | undefined;
    if (!repo) {
      const repoId = `repo_${crypto.randomUUID().slice(0, 8)}`;
      db.prepare(`INSERT INTO repo (id, path, vcs_kind, canonical_remote, fork_remote, default_branch, created_at)
                  VALUES (?, ?, 'github', 'origin', 'origin', 'main', ?)`).run(repoId, origin, Date.now());
      repo = { id: repoId };
    }
    let topic = db.prepare("SELECT id FROM topic WHERE repo_id=? AND title='Legacy sessions'").get(repo.id) as { id: string } | undefined;
    if (!topic) {
      const topicId = `topic_${crypto.randomUUID().slice(0, 8)}`;
      db.prepare(`INSERT INTO topic (id, repo_id, phase, template, title, slug, blocked_on_human, created_at)
                  VALUES (?, ?, 'Draft', 'standard', 'Legacy sessions', 'legacy', 0, ?)`).run(topicId, repo.id, Date.now());
      topic = { id: topicId };
    }
    const insTask = db.prepare(`INSERT INTO task (session_id, topic_id, type, child_branch, worktree_path, created_at)
                                VALUES (?, ?, 'free', ?, ?, ?)`);
    for (const s of sessionRows) {
      insTask.run(s.id, topic.id, s.worktree_branch, s.cwd, Date.now());
    }
  }
}
