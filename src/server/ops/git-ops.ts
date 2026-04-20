import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const exec = promisify(execFile);

/**
 * Deterministic server-side git operations. Each function is a single logical
 * git flow: stage + commit, squash-merge, push, open PR, etc. These replace
 * the previous "ask Claude to run git via prompt" approach. Claude still
 * contributes to the semantic *text* of commits and PRs (see ops/text-gen),
 * but the operations themselves never depend on Claude reasoning correctly
 * about git state.
 */

const GIT_TIMEOUT = 30_000;
const LONG_GIT_TIMEOUT = 120_000;

async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch (e) {
    // execFile rejects with an error whose .stderr often carries the real
    // explanation (commit-msg hook output, branch-checkout refusals, etc.).
    // The default error.message only shows the command — stitch stderr in
    // so the UI banner is actionable instead of "Command failed: git …".
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const detail = (err.stderr || err.stdout || '').trim();
    throw new Error(`git ${args[0]} failed${detail ? ':\n' + detail : ''}`);
  }
}

export async function isDirty(worktreePath: string): Promise<boolean> {
  const out = (await git(['status', '--porcelain'], worktreePath)).trim();
  return out.length > 0;
}

export async function stagedDiff(worktreePath: string): Promise<string> {
  return git(['diff', '--cached'], worktreePath);
}

export async function recentLog(worktreePath: string, n = 10): Promise<string> {
  try { return await git(['log', `-${n}`, '--pretty=format:%h %s'], worktreePath); }
  catch { return ''; }
}

export async function commitListBetween(repoPath: string, baseBranch: string, headBranch: string): Promise<string> {
  try { return await git(['log', `${baseBranch}..${headBranch}`, '--pretty=format:%h %s'], repoPath); }
  catch { return ''; }
}

export async function combinedDiff(repoPath: string, baseBranch: string, headBranch: string): Promise<string> {
  try { return await git(['diff', `${baseBranch}..${headBranch}`], repoPath); }
  catch { return ''; }
}

/** Locate a PR template — best-effort, returns content or null. */
export function readPrTemplate(repoPath: string): string | null {
  const candidates = [
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
    'docs/PULL_REQUEST_TEMPLATE.md',
  ];
  for (const rel of candidates) {
    const p = join(repoPath, rel);
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8'); } catch { /* fall through */ }
    }
  }
  return null;
}

/** Stage every change (tracked + untracked) without committing. */
export async function stageAll(worktreePath: string): Promise<void> {
  await git(['add', '-A'], worktreePath);
}

/** Commit staged changes with the given message. */
export async function commit(worktreePath: string, message: string): Promise<{ sha: string }> {
  await git(['commit', '-m', message], worktreePath);
  const sha = (await git(['rev-parse', 'HEAD'], worktreePath)).trim();
  return { sha };
}

/** Reset staged changes (so a failed flow doesn't leave a dirty index). */
export async function resetStaged(worktreePath: string): Promise<void> {
  try { await git(['reset'], worktreePath); } catch { /* best-effort */ }
}

/** Count commits on `head` not on `base`. */
export async function aheadCount(repoPath: string, base: string, head: string): Promise<number> {
  const out = (await git(['rev-list', '--count', `${base}..${head}`], repoPath)).trim();
  return Number(out) || 0;
}

/**
 * True when `branch` has commits that aren't on its upstream tracking ref
 * yet. Falls back to "is there anything beyond the canonical default" when
 * no upstream is set (first push). Returns false on any git error — safer
 * to hide the Push button than to offer an action that will fail.
 */
export async function hasUnpushedCommits(repoPath: string, branch: string, canonicalRef: string): Promise<boolean> {
  try {
    const out = (await git(['rev-list', '--count', `${branch}@{u}..${branch}`], repoPath)).trim();
    return Number(out) > 0;
  } catch {
    try {
      const out = (await git(['rev-list', '--count', `${canonicalRef}..${branch}`], repoPath)).trim();
      return Number(out) > 0;
    } catch {
      return false;
    }
  }
}

export interface SquashMergeArgs {
  repoPath: string;
  topicBranch: string;
  taskBranch: string;
  message: string;
  tmpWorktreeRoot: string;   // e.g. ~/.claudex/worktrees
}

/**
 * Squash-merge `taskBranch` into `topicBranch` in an isolated temp worktree
 * so we never touch (or depend on the state of) the main clone's checkout.
 * Caller is responsible for making sure the task worktree is clean.
 */
export async function squashMergeToTopic(args: SquashMergeArgs): Promise<{ sha: string }> {
  const ahead = await aheadCount(args.repoPath, args.topicBranch, args.taskBranch);
  if (ahead === 0) throw new Error('Task branch has no new commits beyond the topic branch — nothing to merge.');

  const tmpPath = join(args.tmpWorktreeRoot, `.tmp-merge-${Date.now().toString(36)}`);
  await git(['worktree', 'add', tmpPath, args.topicBranch], args.repoPath);
  try {
    await git(['merge', '--squash', args.taskBranch], tmpPath);
    await git(['commit', '-m', args.message], tmpPath);
    const sha = (await git(['rev-parse', 'HEAD'], tmpPath)).trim();
    return { sha };
  } finally {
    try { await git(['worktree', 'remove', '--force', tmpPath], args.repoPath); } catch { /* best-effort */ }
  }
}

export async function pushBranch(args: { repoPath: string; remote: string; branch: string }): Promise<string> {
  // Specify both local and remote refs so `git push` is independent of HEAD.
  return git(['push', '--set-upstream', args.remote, `${args.branch}:${args.branch}`], args.repoPath, LONG_GIT_TIMEOUT);
}

/**
 * Close an open PR without merging. `gh pr close` is idempotent: closing an
 * already-closed PR prints a warning on stderr but exits 0, so the caller
 * doesn't need to special-case "already closed".
 */
export async function closePullRequest(args: {
  repoPath: string;
  number: number;
  comment?: string;
}): Promise<void> {
  const argv = ['pr', 'close', String(args.number)];
  if (args.comment) argv.push('--comment', args.comment);
  await exec('gh', argv, { cwd: args.repoPath, timeout: LONG_GIT_TIMEOUT, maxBuffer: 16 * 1024 * 1024 });
}

export async function createPullRequest(args: {
  repoPath: string;
  base: string;
  head: string;
  title: string;
  body: string;
}): Promise<{ number: number; url: string }> {
  // `gh pr create` does not support --json; it prints the URL on stdout.
  const { stdout } = await exec('gh', [
    'pr', 'create',
    '--base', args.base, '--head', args.head,
    '--title', args.title, '--body', args.body,
  ], { cwd: args.repoPath, timeout: LONG_GIT_TIMEOUT, maxBuffer: 16 * 1024 * 1024 });
  const numMatch = stdout.match(/\/pull\/(\d+)/);
  const urlMatch = stdout.match(/https?:\/\/\S+/);
  if (!numMatch) throw new Error(`gh pr create returned unexpected output: ${stdout.trim()}`);
  return { number: Number(numMatch[1]), url: urlMatch?.[0] ?? '' };
}
