import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface RepoInput {
  path: string;
  vcsKind: 'github' | 'gitlab';
  canonicalRemote: string;
  forkRemote: string;
  defaultBranch: string;
  canonicalOwner?: string;
  canonicalName?: string;
  forkOwner?: string;
  forkName?: string;
  trackerMcp?: string | null;
  branchTemplate?: string;
  commitTemplate?: string;
  validateCmd?: string | null;
}

export interface Repo {
  id: string;
  path: string;
  vcsKind: 'github' | 'gitlab';
  canonicalRemote: string;
  forkRemote: string;
  defaultBranch: string;
  canonicalOwner: string | null;
  canonicalName: string | null;
  forkOwner: string | null;
  forkName: string | null;
  trackerMcp: string | null;
  branchTemplate: string;
  commitTemplate: string;
  attemptSuffix: string;
  validateCmd: string | null;
  prBodyTemplate: string | null;
  mergeStrategy: 'squash' | 'merge' | 'rebase';
  requiredChecksCache: string[] | null;
  requiredChecksCacheAt: number | null;
  nonVotingOverrides: string[];
  flakyPatterns: string[];
  flakyTests: string[];
  skills: Record<string, string>;
  knownTypes: string[];
  knownProjects: string[];
  createdAt: number;
}

export class RepoStore {
  constructor(private db: Database.Database) {}

  register(input: RepoInput): Repo {
    const id = `repo_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO repo (id, path, vcs_kind, canonical_remote, fork_remote, default_branch,
        canonical_owner, canonical_name, fork_owner, fork_name, tracker_mcp,
        branch_template, commit_template, validate_cmd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.path, input.vcsKind, input.canonicalRemote, input.forkRemote, input.defaultBranch,
      input.canonicalOwner ?? null, input.canonicalName ?? null,
      input.forkOwner ?? null, input.forkName ?? null,
      input.trackerMcp ?? null,
      input.branchTemplate ?? '{gh_user}/{ticket}__{slug}',
      input.commitTemplate ?? '{subject}',
      input.validateCmd ?? null,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): Repo | null {
    const row = this.db.prepare('SELECT * FROM repo WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  getByPath(path: string): Repo | null {
    const row = this.db.prepare('SELECT * FROM repo WHERE path=?').get(path) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  list(): Repo[] {
    return (this.db.prepare('SELECT * FROM repo ORDER BY created_at DESC').all() as Record<string, unknown>[])
      .map((r) => this.hydrate(r));
  }

  updateSkills(id: string, skills: Record<string, string>): void {
    this.db.prepare('UPDATE repo SET skills=? WHERE id=?').run(JSON.stringify(skills), id);
  }

  setNonVotingOverrides(id: string, overrides: string[]): void {
    this.db.prepare('UPDATE repo SET non_voting_overrides=? WHERE id=?').run(JSON.stringify(overrides), id);
  }

  setRequiredChecksCache(id: string, names: string[]): void {
    this.db.prepare('UPDATE repo SET required_checks_cache=?, required_checks_cache_at=? WHERE id=?')
      .run(JSON.stringify(names), Date.now(), id);
  }

  private hydrate(r: Record<string, unknown>): Repo {
    return {
      id: r.id as string, path: r.path as string, vcsKind: r.vcs_kind as 'github' | 'gitlab',
      canonicalRemote: r.canonical_remote as string, forkRemote: r.fork_remote as string,
      defaultBranch: r.default_branch as string,
      canonicalOwner: (r.canonical_owner as string) ?? null, canonicalName: (r.canonical_name as string) ?? null,
      forkOwner: (r.fork_owner as string) ?? null, forkName: (r.fork_name as string) ?? null,
      trackerMcp: (r.tracker_mcp as string) ?? null,
      branchTemplate: r.branch_template as string, commitTemplate: r.commit_template as string,
      attemptSuffix: r.attempt_suffix as string,
      validateCmd: (r.validate_cmd as string) ?? null, prBodyTemplate: (r.pr_body_template as string) ?? null,
      mergeStrategy: r.merge_strategy as 'squash' | 'merge' | 'rebase',
      requiredChecksCache: r.required_checks_cache ? JSON.parse(r.required_checks_cache as string) : null,
      requiredChecksCacheAt: (r.required_checks_cache_at as number) ?? null,
      nonVotingOverrides: JSON.parse(r.non_voting_overrides as string),
      flakyPatterns: JSON.parse(r.flaky_patterns as string),
      flakyTests: JSON.parse(r.flaky_tests as string),
      skills: JSON.parse(r.skills as string),
      knownTypes: JSON.parse(r.known_types as string),
      knownProjects: JSON.parse(r.known_projects as string),
      createdAt: r.created_at as number,
    };
  }

  /**
   * Non-voting CI check overrides per repo. These names are excluded from the
   * failure rollup on the topic page so a known-flaky or slow branch-
   * protection-required check doesn't show as a red gate. Separate table
   * (repo_nonvoting_check) so the write path is cheap and FK-cascaded on
   * repo deletion.
   */
  listNonVoting(repoId: string): string[] {
    const rows = this.db.prepare('SELECT check_name FROM repo_nonvoting_check WHERE repo_id=? ORDER BY check_name')
      .all(repoId) as { check_name: string }[];
    return rows.map((r) => r.check_name);
  }

  listNonVotingDetailed(repoId: string): { checkName: string; reason: string | null; suppressedAt: number }[] {
    const rows = this.db.prepare('SELECT check_name, reason, suppressed_at FROM repo_nonvoting_check WHERE repo_id=? ORDER BY check_name')
      .all(repoId) as { check_name: string; reason: string | null; suppressed_at: number }[];
    return rows.map((r) => ({ checkName: r.check_name, reason: r.reason, suppressedAt: r.suppressed_at }));
  }

  addNonVoting(repoId: string, checkName: string, reason?: string | null): void {
    this.db.prepare(`INSERT OR REPLACE INTO repo_nonvoting_check
      (repo_id, check_name, reason, suppressed_at) VALUES (?, ?, ?, ?)`)
      .run(repoId, checkName, reason ?? null, Date.now());
  }

  removeNonVoting(repoId: string, checkName: string): void {
    this.db.prepare('DELETE FROM repo_nonvoting_check WHERE repo_id=? AND check_name=?').run(repoId, checkName);
  }
}
