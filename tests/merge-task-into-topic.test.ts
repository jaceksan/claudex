import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTaskIntoTopic } from '../src/server/ops/git-ops';

const run = promisify(execFile);
const g = (args: string[], cwd: string) =>
  run('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

async function init(): Promise<{ repo: string; tmp: string }> {
  const root = await mkdtemp(join(tmpdir(), 'claudex-merge-'));
  const repo = join(root, 'r');
  await g(['init', '-q', '-b', 'main', repo], root);
  await writeFile(join(repo, 'README'), 'seed\n');
  await g(['add', '.'], repo);
  await g(['commit', '-q', '-m', 'seed'], repo);
  return { repo, tmp: join(root, 'tmp') };
}

async function rev(repo: string, ref: string): Promise<string> {
  const { stdout } = await g(['rev-parse', ref], repo);
  return stdout.trim();
}
async function logOneline(repo: string, ref: string): Promise<string[]> {
  const { stdout } = await g(['log', '--format=%s', ref], repo);
  return stdout.trim().split('\n').filter(Boolean);
}

describe('mergeTaskIntoTopic', () => {
  let repo: string; let tmp: string; let root: string;
  let topicWT: string; let taskWT: string;
  beforeEach(async () => {
    const x = await init(); repo = x.repo; tmp = x.tmp;
    root = join(repo, '..');
    // In production the topic branch is NOT checked out at merge time — it's
    // just a ref that the temp merge worktree operates on. Here we use a
    // scratch worktree to create commits on each branch, then remove it so
    // the ref is free for mergeTaskIntoTopic's own `git worktree add`.
    topicWT = join(root, 'wt-topic');
    taskWT = join(root, 'wt-task');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Write files + commit on `branch` via a throwaway worktree, then tear it
   *  down. Leaves `branch` advanced but not checked out anywhere, matching
   *  the production shape at merge time. */
  async function commitOn(branch: string, wtPath: string, files: Record<string, string>, msg: string, baseRef = 'main'): Promise<void> {
    const exists = await g(['rev-parse', '--verify', `refs/heads/${branch}`], repo).then(() => true).catch(() => false);
    if (!exists) await g(['worktree', 'add', '-b', branch, wtPath, baseRef], repo);
    else await g(['worktree', 'add', wtPath, branch], repo);
    for (const [rel, content] of Object.entries(files)) await writeFile(join(wtPath, rel), content);
    await g(['add', '.'], wtPath);
    await g(['commit', '-q', '-m', msg], wtPath);
    await g(['worktree', 'remove', '--force', wtPath], repo);
  }
  const topicCommit = (files: Record<string, string>, msg: string) => commitOn('topic', topicWT, files, msg);
  const taskCommit = (files: Record<string, string>, msg: string) => commitOn('task', taskWT, files, msg);

  it('fast-forwards when topic has no commits that task lacks', async () => {
    await g(['branch', 'topic', 'main'], repo); // topic exists, no new commits
    await taskCommit({ a: 'a1\n' }, 'feat: a1');
    await taskCommit({ a: 'a2\n' }, 'feat: a2');
    const taskTip = await rev(repo, 'task');

    const res = await mergeTaskIntoTopic({ repoPath: repo, topicBranch: 'topic', taskBranch: 'task', tmpWorktreeRoot: tmp });

    expect(res.kind).toBe('fast-forward');
    expect(res.count).toBe(2);
    expect(res.sha).toBe(taskTip); // SHA preserved — pointer move only
    expect(await rev(repo, 'topic')).toBe(taskTip);
    expect(await logOneline(repo, 'topic')).toEqual(['feat: a2', 'feat: a1', 'seed']);
  });

  it('cherry-picks each commit when topic has diverged', async () => {
    await taskCommit({ a: 'a1\n' }, 'feat: a1');
    await taskCommit({ a: 'a2\n' }, 'feat: a2');
    await topicCommit({ b: 'b1\n' }, 'feat: b1');

    const res = await mergeTaskIntoTopic({ repoPath: repo, topicBranch: 'topic', taskBranch: 'task', tmpWorktreeRoot: tmp });

    expect(res.kind).toBe('cherry-pick');
    expect(res.count).toBe(2);
    // Messages preserved, new SHAs, topic's b1 stays an ancestor.
    expect(await logOneline(repo, 'topic')).toEqual(['feat: a2', 'feat: a1', 'feat: b1', 'seed']);
    // Task branch unaltered by the merge.
    expect(await logOneline(repo, 'task')).toEqual(['feat: a2', 'feat: a1', 'seed']);
  });

  it('throws a clear error and leaves topic untouched on cherry-pick conflict', async () => {
    await taskCommit({ a: 'task-side\n' }, 'feat: task edit');
    await topicCommit({ a: 'topic-side\n' }, 'feat: topic edit');
    const topicBefore = await rev(repo, 'topic');

    await expect(
      mergeTaskIntoTopic({ repoPath: repo, topicBranch: 'topic', taskBranch: 'task', tmpWorktreeRoot: tmp }),
    ).rejects.toThrow(/Cherry-pick conflict/i);

    // Topic ref unchanged, no half-applied cherry-pick left behind.
    expect(await rev(repo, 'topic')).toBe(topicBefore);
  });

  it('throws "nothing to merge" when task has no commits beyond topic', async () => {
    await g(['branch', 'topic', 'main'], repo);
    await g(['branch', 'task', 'main'], repo);
    await expect(
      mergeTaskIntoTopic({ repoPath: repo, topicBranch: 'topic', taskBranch: 'task', tmpWorktreeRoot: tmp }),
    ).rejects.toThrow(/nothing to merge/i);
  });
});
