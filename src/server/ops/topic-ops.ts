import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import type { TaskStore } from '../task.js';
import type { TopicStore } from '../topic.js';
import type { RepoStore } from '../repo.js';
import type { PrLifecycle } from '../pr-lifecycle.js';
import * as gitOps from './git-ops.js';
import { generateMergeCommitMessage, generatePrDescription } from './text-gen.js';

/**
 * Higher-level topic orchestration: the git/gh dance plus DB bookkeeping for
 * "merge this attempt" and "open a PR for this topic". Hub handlers and
 * quick-fix-auto share this code path so both flows stay on the
 * deterministic-git + one-shot-Claude-text architecture.
 */

export interface TopicOpsDeps {
  tasks: TaskStore;
  topics: TopicStore;
  repos: RepoStore;
  prLifecycle?: PrLifecycle;
  /** Optional hook fired after a successful operation. Hub wires this to refreshTopicDetail. */
  onTopicChanged?: (topicId: string) => void;
}

/**
 * Merge a task's attempt into its topic branch via a temporary worktree so
 * the main clone is never touched. Updates task.acceptedAt,
 * topic.acceptedAttemptId, and cascades sibling discards. Idempotent-ish
 * guards upstream: caller should check task.acceptedAt / discardedAt first.
 */
export async function mergeAttemptToTopic(
  sessionId: string,
  deps: TopicOpsDeps,
): Promise<{ sha: string }> {
  const task = deps.tasks.getBySession(sessionId);
  if (!task) throw new Error(`task ${sessionId} not found`);
  if (task.type !== 'attempt') throw new Error('not an attempt task');
  if (task.acceptedAt || task.discardedAt) throw new Error('task already finalised');
  const topic = deps.topics.getById(task.topicId);
  if (!topic) throw new Error('topic not found');
  if (!topic.topicBranch || !task.childBranch) throw new Error('missing branch info');
  const repo = deps.repos.getById(topic.repoId);
  if (!repo) throw new Error('repo not found');
  if (task.worktreePath && (await gitOps.isDirty(task.worktreePath))) {
    throw new Error('Uncommitted changes in the task worktree — Save or Discard changes first.');
  }

  const commits = await gitOps.commitListBetween(repo.path, topic.topicBranch, task.childBranch);
  const diff = await gitOps.combinedDiff(repo.path, topic.topicBranch, task.childBranch);
  const message = await generateMergeCommitMessage({
    cwd: repo.path,
    topicBranch: topic.topicBranch,
    taskBranch: task.childBranch,
    topicTitle: topic.title,
    taskLabel: task.label,
    ticketKey: topic.ticketKey,
    commitList: commits,
    combinedDiff: diff,
  });
  if (!message) throw new Error('Claude returned an empty merge commit message.');

  const merged = await gitOps.squashMergeToTopic({
    repoPath: repo.path,
    topicBranch: topic.topicBranch,
    taskBranch: task.childBranch,
    message,
    tmpWorktreeRoot: pathJoin(homedir(), '.claudex', 'worktrees'),
  });

  deps.tasks.markAccepted(sessionId);
  deps.topics.setPhase(topic.id, topic.phase === 'Open' ? 'Open' : 'Draft', { acceptedAttemptId: sessionId });
  for (const t of deps.tasks.listByTopic(topic.id)) {
    if (t.type === 'attempt' && t.sessionId !== sessionId && !t.acceptedAt && !t.discardedAt) {
      deps.tasks.markDiscarded(t.sessionId);
    }
  }
  deps.onTopicChanged?.(topic.id);
  return merged;
}

/**
 * Create a PR for the topic using the deterministic git/gh flow. Claude
 * contributes only the title + body via `claude -p`. Fails loudly if the
 * topic isn't in Draft phase or lacks a topic branch.
 */
export async function createPrForTopic(
  topicId: string,
  deps: TopicOpsDeps,
  args: { suggestedTitle?: string; suggestedBody?: string } = {},
): Promise<{ number: number; url: string }> {
  const topic = deps.topics.getById(topicId);
  if (!topic) throw new Error('topic not found');
  if (!topic.topicBranch) throw new Error('topic has no branch');
  if (topic.phase !== 'Draft') throw new Error(`cannot create PR in phase ${topic.phase}`);
  const repo = deps.repos.getById(topic.repoId);
  if (!repo) throw new Error('repo not found');

  await gitOps.pushBranch({ repoPath: repo.path, remote: repo.forkRemote, branch: topic.topicBranch });

  const commits = await gitOps.commitListBetween(repo.path, repo.defaultBranch, topic.topicBranch);
  const diff = await gitOps.combinedDiff(repo.path, repo.defaultBranch, topic.topicBranch);
  const template = gitOps.readPrTemplate(repo.path);
  const { title, body } = await generatePrDescription({
    cwd: repo.path,
    topicBranch: topic.topicBranch,
    defaultBranch: repo.defaultBranch,
    topicTitle: topic.title,
    ticketKey: topic.ticketKey,
    suggestedTitle: args.suggestedTitle,
    suggestedBody: args.suggestedBody,
    commitList: commits,
    combinedDiff: diff,
    prTemplate: template,
  });

  const pr = await gitOps.createPullRequest({
    repoPath: repo.path,
    base: repo.defaultBranch,
    head: topic.topicBranch,
    title, body,
  });

  deps.topics.setPhase(topicId, 'Open', { prNumber: pr.number });
  deps.onTopicChanged?.(topicId);

  // Arm CI watching — best-effort.
  if (deps.prLifecycle) {
    deps.prLifecycle.watchCi(topicId, true).catch((e) => console.error('[ci-watch] arm error', e));
  }
  return pr;
}
