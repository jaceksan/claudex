import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WorktreeInfo {
  /** Absolute path to the worktree that will become the session cwd. */
  path: string;
  /** Absolute path to the source repo the worktree was cut from. */
  origin: string;
  /** Branch name created for this worktree. */
  branch: string;
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function worktreeRoot(): string {
  const dir = path.join(os.homedir(), '.claudex', 'worktrees');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveGitRoot(cwd: string): string | null {
  try { return run('git', ['rev-parse', '--show-toplevel'], cwd); }
  catch { return null; }
}

/** Sanitise a relative path for use as a worktree location. Preserves `/` as a subdir
 * separator (so `user/topic__task` nests under `user/`), but scrubs shell-hostile chars
 * from each segment and caps each segment at 100 chars. */
export function safeDirName(input: string): string {
  return input
    .split('/')
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100))
    .filter((seg) => seg.length > 0)
    .join('/');
}

export function createWorktree(
  sourceCwd: string,
  uiId: string,
  opts: { branch: string; base?: string; dirName?: string },
): WorktreeInfo {
  const origin = resolveGitRoot(sourceCwd);
  if (!origin) {
    throw new Error(`Worktree requested but ${sourceCwd} is not inside a git repository.`);
  }
  const { branch, base, dirName } = opts;
  // Prefer a human-readable dir name when callers provide one; fall back to uiId so
  // the launcher "useWorktree" flow (which has no semantic name) still works.
  const slot = dirName ? safeDirName(dirName) : uiId;
  // If two callers happen to generate the same dirName for different uiIds (e.g. the
  // same branch name retried), suffix with a short uiId fragment for uniqueness.
  let wtPath = path.join(worktreeRoot(), slot);
  if (dirName && existsSync(wtPath)) {
    wtPath = path.join(worktreeRoot(), `${slot}-${uiId.slice(0, 6)}`);
  }
  if (existsSync(wtPath)) {
    // Cleanup a stale path left over from a crashed prior session under the same id.
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  // Nested dirs (e.g. jaceksan/repo__...) need their parent created first; git worktree add
  // creates only the leaf.
  mkdirSync(path.dirname(wtPath), { recursive: true });
  const addArgs = base
    ? ['worktree', 'add', '-b', branch, wtPath, base]
    : ['worktree', 'add', '-b', branch, wtPath];
  run('git', addArgs, origin);
  return { path: wtPath, origin, branch };
}

export function removeWorktree(origin: string, wtPath: string): void {
  // Never touch the source repo even if state got corrupted and wtPath == origin.
  // Only rm paths that live under ~/.claudex/worktrees/.
  const claudexRoot = path.join(os.homedir(), '.claudex', 'worktrees');
  const normalized = path.resolve(wtPath);
  const safe = normalized.startsWith(claudexRoot + path.sep) && normalized !== path.resolve(origin);
  try {
    run('git', ['worktree', 'remove', '--force', wtPath], origin);
  } catch {
    try { run('git', ['worktree', 'prune'], origin); } catch { /* ignore */ }
    if (safe) {
      try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
