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

export function createWorktree(
  sourceCwd: string,
  uiId: string,
  opts: { branch: string; base?: string },
): WorktreeInfo {
  const origin = resolveGitRoot(sourceCwd);
  if (!origin) {
    throw new Error(`Worktree requested but ${sourceCwd} is not inside a git repository.`);
  }
  const { branch, base } = opts;
  const wtPath = path.join(worktreeRoot(), uiId);
  if (existsSync(wtPath)) {
    // Cleanup a stale path left over from a crashed prior session under the same id.
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
