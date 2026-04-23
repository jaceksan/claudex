import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { RepoStore } from './repo.js';
import type { TopicStore, TopicTemplate } from './topic.js';
import type { TaskStore } from './task.js';
import { renderBranchTemplate } from './branch-template.js';
import { slugify } from './slug.js';
import { closePullRequest, attemptRebaseOnto } from './ops/git-ops.js';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';

export interface SpawnedSession { id: string; }
export type Git = (args: string[], cwd?: string) => Promise<string>;
export type CreateWt = (cwd: string, uiId: string, opts: { branch: string; base?: string; dirName?: string }) => { path: string; origin: string; branch: string };

export interface OnFixAccepted {
  onFixAccepted(topic: import('./topic.js').Topic, task: import('./task.js').Task, commitSha: string): Promise<void>;
}

export interface TopicManagerDeps {
  db: Database.Database;
  repos: RepoStore;
  topics: TopicStore;
  tasks: TaskStore;
  git: Git;
  createWorktree: CreateWt;
  spawnSession: (args: {
    cwd: string;
    label: string;
    prompt?: string;
    effort: string;
    permissionMode: string;
    presetUiId?: string;
    worktree?: { path: string; origin: string; branch: string };
    appendSystemPrompt?: string;
  }) => Promise<SpawnedSession>;
  deleteSession?: (sessionId: string) => void;
  now: () => number;
  githubLogin: () => Promise<string>;
  prLifecycle?: OnFixAccepted;
}

export interface CreateTopicInput {
  repoId: string;
  template: TopicTemplate;
  title: string;
  ticketKey?: string | null;
  type?: string;
  project?: string;
  branchOverride?: string;
}

export class TopicManager {
  constructor(private d: TopicManagerDeps) {}

  async create(input: CreateTopicInput) {
    const repo = this.d.repos.getById(input.repoId);
    if (!repo) throw new Error(`repo ${input.repoId} not found`);
    const slug = slugify(input.title);

    if (input.template === 'exploration') {
      const topic = this.d.topics.create({
        repoId: repo.id, phase: 'Exploring', template: 'exploration',
        title: input.title, slug, ticketKey: input.ticketKey ?? null, topicBranch: null,
      });
      return { topic };
    }

    let topicBranch: string;
    if (input.branchOverride?.trim()) {
      topicBranch = input.branchOverride.trim();
    } else {
      const ghUser = await this.d.githubLogin();
      const branchCtx: Record<string, string> = {
        gh_user: ghUser, ticket: input.ticketKey ?? '', slug,
        type: input.type ?? '', project: input.project ?? '',
      };
      topicBranch = renderBranchTemplate(repo.branchTemplate, branchCtx);
    }

    await this.d.git(['fetch', repo.canonicalRemote, repo.defaultBranch], repo.path);
    await this.d.git(['branch', topicBranch, `${repo.canonicalRemote}/${repo.defaultBranch}`], repo.path);

    const topic = this.d.topics.create({
      repoId: repo.id, phase: 'Draft', template: input.template,
      title: input.title, slug, ticketKey: input.ticketKey ?? null, topicBranch,
    });
    return { topic };
  }

  async addAttempt(topicId: string, args: { prompt?: string; effort: string; permissionMode: string; label?: string }) {
    const topic = this.d.topics.getById(topicId);
    if (!topic) throw new Error(`topic ${topicId} not found`);
    // Attempts are allowed in Draft (before PR) and Open (after PR) — users
    // often want to iterate on a feature branch with more worktree-isolated
    // tasks after the PR is already open (each such attempt then gets merged
    // into the topic branch, which the next push propagates to the PR).
    if (topic.phase !== 'Draft' && topic.phase !== 'Open') {
      throw new Error(`cannot add attempt: phase ${topic.phase}`);
    }
    const repo = this.d.repos.getById(topic.repoId)!;

    // Task title is required — it becomes the slug used in the branch and worktree name.
    // No auto-numbered fallback; the UI surfaces the error on submit.
    const rawLabel = args.label?.trim() ?? '';
    if (!rawLabel) throw new Error('task title is required');
    const taskSlug = slugify(rawLabel);
    if (!taskSlug) throw new Error('task title must contain at least one letter or digit');

    // Branch: <topic-branch>__<task-slug>. Must be unique within the repo; the slug
    // collision check detects duplicates before we even touch git.
    const existing = this.d.tasks.listByTopic(topicId)
      .filter((t) => t.type === 'attempt' && !t.discardedAt)
      .map((t) => slugify(t.label ?? ''));
    if (existing.includes(taskSlug)) {
      throw new Error(`a task with title "${rawLabel}" already exists on this topic`);
    }
    const attemptBranch = `${topic.topicBranch!}__${taskSlug}`;
    const branchExists = (await this.d.git(['branch', '--list', attemptBranch], repo.path)).trim() !== '';
    if (branchExists) {
      throw new Error(`branch ${attemptBranch} already exists — pick a different task title or delete the leftover branch`);
    }

    // Worktree dir: <gh_user>/<repo-base>__<ticket>__<topic-slug>__<task-slug>. Repo gets
    // injected here (not in the branch) because worktrees live in a single global dir
    // under ~/.claudex/worktrees and can collide across repos; branches can't.
    const presetUiId = randomUUID();
    const ghUser = await this.d.githubLogin().catch(() => 'claudex');
    const repoBase = repo.path.split('/').pop() ?? 'repo';
    const dirTail = renderBranchTemplate('{repo}__{ticket}__{slug}__{task}', {
      repo: repoBase, ticket: topic.ticketKey ?? '', slug: topic.slug, task: taskSlug,
    });
    const dirName = `${ghUser}/${dirTail}`;
    const wt = this.d.createWorktree(repo.path, presetUiId, {
      branch: attemptBranch,
      base: topic.topicBranch!,
      dirName,
    });
    const session = await this.d.spawnSession({
      cwd: wt.path, label: rawLabel,
      prompt: args.prompt, effort: args.effort, permissionMode: args.permissionMode,
      presetUiId, worktree: wt,
      appendSystemPrompt: orientationHint({
        cwd: wt.path, branch: attemptBranch, base: topic.topicBranch!,
        topicTitle: topic.title, taskLabel: rawLabel,
      }),
    });
    return this.d.tasks.create({
      sessionId: session.id, topicId, type: 'attempt',
      label: rawLabel,
      childBranch: attemptBranch, worktreePath: wt.path,
    });
  }

  /** Commit uncommitted changes inside the task worktree. */
  async saveTask(sessionId: string, message?: string) {
    const task = this.d.tasks.getBySession(sessionId);
    if (!task) throw new Error(`task ${sessionId} not found`);
    if (!task.worktreePath) throw new Error('task has no worktree to save in');
    const dirty = (await this.d.git(['status', '--porcelain'], task.worktreePath)).trim();
    if (!dirty) throw new Error('Nothing to save — no uncommitted changes.');
    await this.d.git(['add', '-A'], task.worktreePath);
    const topic = this.d.topics.getById(task.topicId)!;
    const subject = (message ?? task.label ?? topic.title).trim() || 'WIP';
    const msg = `${topic.ticketKey ? topic.ticketKey + ': ' : ''}${subject}`;
    await this.d.git(['commit', '-m', msg], task.worktreePath);
  }

  /** Drop all uncommitted changes in the task worktree. Keeps commits + worktree + session. */
  async discardTaskChanges(sessionId: string) {
    const task = this.d.tasks.getBySession(sessionId);
    if (!task) throw new Error(`task ${sessionId} not found`);
    if (!task.worktreePath) throw new Error('task has no worktree');
    try { await this.d.git(['restore', '.'], task.worktreePath); } catch { /* empty tree ok */ }
    await this.d.git(['clean', '-fd'], task.worktreePath);
  }

  /** Hard-kill the task: end subprocess, remove worktree, delete branch, mark discarded. */
  async discardTaskHard(sessionId: string) {
    const task = this.d.tasks.getBySession(sessionId);
    if (!task) throw new Error(`task ${sessionId} not found`);
    const topic = this.d.topics.getById(task.topicId)!;
    const repo = this.d.repos.getById(topic.repoId)!;

    if (this.d.deleteSession) {
      try { this.d.deleteSession(sessionId); } catch { /* best-effort */ }
    }
    if (task.worktreePath) {
      try { await this.d.git(['worktree', 'remove', '--force', task.worktreePath], repo.path); }
      catch { /* might already be gone via deleteSession */ }
    }
    if (task.childBranch) {
      try { await this.d.git(['branch', '-D', task.childBranch], repo.path); }
      catch { /* ignore */ }
    }
    // Mark discarded only if not already accepted (don't clobber provenance).
    if (!task.acceptedAt && !task.discardedAt) {
      this.d.tasks.markDiscarded(sessionId);
    }
  }

  /** Squash-merge an attempt task into the topic branch. Refuses dirty worktree. */
  async acceptAttempt(sessionId: string) {
    const task = this.d.tasks.getBySession(sessionId);
    if (!task) throw new Error(`task ${sessionId} not found`);
    if (task.type !== 'attempt') throw new Error('not an attempt task');
    const topic = this.d.topics.getById(task.topicId)!;
    const repo = this.d.repos.getById(topic.repoId)!;

    // Refuse if the task worktree still has uncommitted changes — non-tech users should
    // make an explicit Save or Discard changes decision before losing work to a merge.
    if (task.worktreePath) {
      const dirty = (await this.d.git(['status', '--porcelain'], task.worktreePath)).trim();
      if (dirty) {
        throw new Error('Uncommitted changes in the task worktree — Save or Discard changes first, then merge.');
      }
    }

    const ahead = (await this.d.git(
      ['rev-list', '--count', `${topic.topicBranch!}..${task.childBranch!}`],
      repo.path,
    )).trim();
    if (ahead === '0') {
      throw new Error('This task has no commits yet — Save its changes first, or Discard the task.');
    }

    await this.d.git(['checkout', topic.topicBranch!], repo.path);
    await this.d.git(['merge', '--squash', task.childBranch!], repo.path);
    const msg = `${topic.ticketKey ? topic.ticketKey + ': ' : ''}${topic.title}`;
    await this.d.git(['commit', '-m', msg], repo.path);
    this.d.tasks.markAccepted(sessionId);
    this.d.topics.setPhase(topic.id, 'Draft', { acceptedAttemptId: sessionId });
    for (const t of this.d.tasks.listByTopic(topic.id)) {
      if (t.type === 'attempt' && t.sessionId !== sessionId && !t.acceptedAt && !t.discardedAt) {
        this.d.tasks.markDiscarded(t.sessionId);
      }
    }
  }

  async discardAttempt(sessionId: string) {
    this.d.tasks.markDiscarded(sessionId);
  }

  /**
   * Passive auto-reconcile for merges performed outside the server (e.g. a
   * developer using `git` directly). For each
   * open attempt, `git cherry <topic-branch> <task-branch>` lists commits on
   * the task branch and marks which ones are equivalent to commits on the
   * topic branch. When every line starts with `-` (or output is empty) the
   * task's patches are all already on the topic branch, which squash + rebase
   * merges both produce — so treat the task as accepted.
   *
   * Idempotent and cheap (one `git cherry` per open attempt). Called from
   * computeDeliverable and from buildTopicDetail so the UI converges naturally.
   */
  async reconcileMergedAttempts(topicId: string): Promise<void> {
    const topic = this.d.topics.getById(topicId);
    if (!topic?.topicBranch) return;
    const repo = this.d.repos.getById(topic.repoId);
    if (!repo) return;

    const open = this.d.tasks.listByTopic(topicId).filter((t) =>
      t.type === 'attempt' && !t.acceptedAt && !t.discardedAt && t.childBranch,
    );
    if (open.length === 0) return;

    for (const t of open) {
      try {
        const out = (await this.d.git(['cherry', topic.topicBranch, t.childBranch!], repo.path)).trim();
        // `git cherry` is empty when the task branch has no commits not already
        // on the topic branch — which also holds true for a *brand-new* task
        // branch that hasn't diverged yet. Require at least one matched line
        // (prefixed `-`) before declaring the task merged, otherwise every
        // freshly spawned attempt would be auto-accepted before the user even
        // changes a file.
        const lines = out === '' ? [] : out.split('\n');
        const merged = lines.length > 0 && lines.every((l) => l.startsWith('-'));
        if (!merged) continue;
        this.d.tasks.markAccepted(t.sessionId);
        const current = this.d.topics.getById(topicId)!;
        if (!current.acceptedAttemptId) {
          this.d.topics.setPhase(topic.id, current.phase, { acceptedAttemptId: t.sessionId });
          // Cascade: all other open attempts are now superseded.
          for (const s of this.d.tasks.listByTopic(topicId)) {
            if (s.type === 'attempt' && s.sessionId !== t.sessionId && !s.acceptedAt && !s.discardedAt) {
              this.d.tasks.markDiscarded(s.sessionId);
            }
          }
        }
      } catch { /* best-effort — don't block detail rendering on git hiccups */ }
    }
  }

  /**
   * Sync the topic branch with the canonical default branch. Tries to rebase
   * cleanly; if clean, fast-forwards the topic branch and returns. On
   * conflict, leaves the rebase-in-progress in a dedicated worktree and
   * spawns a `rebase` task session seeded with the conflict file list so
   * Claude can resolve the conflicts interactively. User then runs
   * `git rebase --continue` inside the session until the rebase finishes.
   */
  async syncTopicWithMain(topicId: string): Promise<{
    status: 'up-to-date' | 'fast-forwarded' | 'clean-rebase' | 'conflict';
    resultSha?: string;
    sessionId?: string;
    conflictFiles?: string[];
  }> {
    const topic = this.d.topics.getById(topicId);
    if (!topic) throw new Error(`topic ${topicId} not found`);
    if (!topic.topicBranch) throw new Error('topic has no branch — exploration topics cannot be synced');
    const repo = this.d.repos.getById(topic.repoId)!;

    // Reject when a rebase task is already in flight; only one at a time.
    const existing = this.d.tasks.listByTopic(topicId)
      .find((t) => t.type === 'rebase' && !t.acceptedAt && !t.discardedAt);
    if (existing) throw new Error('A rebase task is already in progress — resolve or discard it first.');

    await this.d.git(['fetch', repo.canonicalRemote, repo.defaultBranch], repo.path);
    const canonicalRef = `${repo.canonicalRemote}/${repo.defaultBranch}`;

    const ghUser = await this.d.githubLogin().catch(() => 'claudex');
    const repoBase = repo.path.split('/').pop() ?? 'repo';
    const dirTail = renderBranchTemplate('{repo}__{ticket}__{slug}__claudex_rebase', {
      repo: repoBase, ticket: topic.ticketKey ?? '', slug: topic.slug,
    });
    const dirName = `${ghUser}/${dirTail}`;

    const result = await attemptRebaseOnto({
      repoPath: repo.path,
      branch: topic.topicBranch,
      upstreamRef: canonicalRef,
      worktreeRoot: pathJoin(homedir(), '.claudex', 'worktrees'),
      dirName,
    });

    if (result.status !== 'conflict') {
      return { status: result.status, resultSha: result.resultSha };
    }

    // Conflict path — spawn a rebase task on the paused worktree.
    const presetUiId = randomUUID();
    const label = `rebase: ${topic.title}`;
    const files = result.conflictFiles ?? [];
    const prompt = [
      `The topic branch \`${topic.topicBranch}\` is being rebased onto \`${canonicalRef}\`.`,
      `Git is paused mid-rebase with conflicts in these files:`,
      files.map((f) => `  - ${f}`).join('\n'),
      ``,
      `Please resolve each conflict: read the markers, understand both sides, and write the correct merged code. After a file is clean, \`git add\` it. When every file is staged, run \`git rebase --continue\`. If more conflicts appear mid-sequence, repeat until the rebase finishes.`,
      ``,
      `Do NOT run \`git rebase --abort\` unless the user explicitly asks you to. Do NOT merge, push, or open PRs — that's handled via claudex buttons once the rebase finishes.`,
    ].join('\n');

    const session = await this.d.spawnSession({
      cwd: result.worktreePath!,
      label,
      prompt,
      effort: 'high',
      permissionMode: 'acceptEdits',
      presetUiId,
      worktree: { path: result.worktreePath!, origin: repo.path, branch: result.rebaseBranch! },
      appendSystemPrompt: orientationHint({
        cwd: result.worktreePath!, branch: result.rebaseBranch!, base: canonicalRef,
        topicTitle: topic.title, taskLabel: 'rebase',
      }),
    });
    this.d.tasks.create({
      sessionId: session.id, topicId, type: 'rebase', label,
      childBranch: result.rebaseBranch, worktreePath: result.worktreePath,
      parentTrigger: { conflictFiles: files },
    });
    return { status: 'conflict', sessionId: session.id, conflictFiles: files };
  }

  async addFixTask(topicId: string, args: {
    type: 'fix-comments' | 'fix-ci';
    prompt: string;
    effort: string;
    permissionMode: string;
    label?: string;
    parentTrigger?: unknown;
  }) {
    const topic = this.d.topics.getById(topicId);
    if (!topic) throw new Error(`topic ${topicId} not found`);
    const repo = this.d.repos.getById(topic.repoId)!;

    // Valid phases: Open, or Draft when an attempt has been accepted.
    if (topic.phase !== 'Open' && !(topic.phase === 'Draft' && topic.acceptedAttemptId)) {
      throw new Error(`cannot add fix task in phase ${topic.phase}`);
    }

    // Concurrency guard: reject if any attempt/fix-* task is currently running.
    const running = this.d.tasks.listRunningByTopic(topicId)
      .filter((t) => t.type === 'attempt' || t.type === 'fix-comments' || t.type === 'fix-ci');
    if (running.length > 0) {
      throw new Error(`cannot add fix task: another task (${running[0].type}) is already running`);
    }

    // Fix branch: <topic-branch>__claudex_fix__<n>, n = existing fix tasks + 1.
    // Bump past pre-existing branches from partial failures (same bump logic as attempt).
    const presetUiId = randomUUID();
    const existingFix = this.d.tasks.listByTopic(topicId)
      .filter((t) => t.type === 'fix-comments' || t.type === 'fix-ci');
    let childBranch = '';
    let fixN = 0;
    for (let n = existingFix.length + 1; n <= existingFix.length + 50; n++) {
      const candidate = `${topic.topicBranch}__claudex_fix__${n}`;
      const branchExists = (await this.d.git(['branch', '--list', candidate], repo.path)).trim() !== '';
      if (!branchExists) { childBranch = candidate; fixN = n; break; }
    }
    if (!childBranch) throw new Error('could not find a free fix branch name');

    const ghUser = await this.d.githubLogin().catch(() => 'claudex');
    const repoBase = repo.path.split('/').pop() ?? 'repo';
    const dirTail = renderBranchTemplate('{repo}__{ticket}__{slug}__claudex_fix__{n}', {
      repo: repoBase, ticket: topic.ticketKey ?? '', slug: topic.slug, n: String(fixN),
    });
    // Fresh-base guard: fetch the topic branch from the fork remote and
    // fast-forward the local ref if the remote has moved ahead. Without this,
    // a fix task spawned after someone committed directly to the topic's
    // remote branch would base off a stale tip and produce a commit that
    // doesn't apply cleanly — exactly the state observed in session
    // b35815f8 where a manual push diverged the remote from local.
    const topicBranch = topic.topicBranch!;
    try {
      await this.d.git(['fetch', repo.forkRemote, topicBranch], repo.path);
      const remoteSha = (await this.d.git(['rev-parse', `${repo.forkRemote}/${topicBranch}`], repo.path)).trim();
      const localSha = (await this.d.git(['rev-parse', topicBranch], repo.path)).trim();
      if (remoteSha && localSha && remoteSha !== localSha) {
        const mergeBase = (await this.d.git(['merge-base', localSha, remoteSha], repo.path)).trim();
        if (mergeBase === localSha) {
          // Fast-forward only — never rewrite local history here.
          await this.d.git(['update-ref', `refs/heads/${topicBranch}`, remoteSha, localSha], repo.path);
        }
      }
    } catch {
      // Best-effort; fall through to whatever the local ref points at.
    }
    const wt = this.d.createWorktree(repo.path, presetUiId, {
      branch: childBranch,
      base: topicBranch,
      dirName: `${ghUser}/${dirTail}`,
    });
    const session = await this.d.spawnSession({
      cwd: wt.path,
      label: args.label ?? args.type,
      prompt: args.prompt,
      effort: args.effort,
      permissionMode: args.permissionMode,
      presetUiId, worktree: wt,
      appendSystemPrompt: orientationHint({
        cwd: wt.path, branch: childBranch, base: topicBranch,
        topicTitle: topic.title, taskLabel: args.label ?? args.type,
      }),
    });
    return this.d.tasks.create({
      sessionId: session.id, topicId, type: args.type,
      label: args.label ?? args.type,
      childBranch, worktreePath: wt.path,
      parentTrigger: args.parentTrigger,
    });
  }

  async deleteTopic(topicId: string) {
    const topic = this.d.topics.getById(topicId);
    if (!topic) throw new Error(`topic ${topicId} not found`);
    const repo = this.d.repos.getById(topic.repoId);

    // If the topic still has an *open* PR, close it before tearing everything
    // down — otherwise the PR is orphaned on GitHub with a dangling head ref.
    // Merged or Closed PRs are never touched: they're historical and must be
    // preserved for audit.
    if (repo && topic.prNumber && topic.phase === 'Open') {
      try {
        await closePullRequest({
          repoPath: repo.path, number: topic.prNumber,
          comment: 'Closed by claudex — topic deleted.',
        });
      } catch (e) {
        console.warn(`[deleteTopic] could not close PR #${topic.prNumber}:`, (e as Error).message);
        // Proceed anyway; the local cleanup is more important than a clean remote.
      }
    }

    // Kill every session attached to this topic (handles in-memory + persisted rows).
    // sessionManager.delete emits 'deleted', which the hub uses to cascade-delete the
    // session row via FK, which in turn cascades task rows. For sessions the manager
    // doesn't know about, fall back to raw DB delete.
    const siblingTasks = this.d.tasks.listByTopic(topicId);
    for (const t of siblingTasks) {
      if (this.d.deleteSession) {
        try { this.d.deleteSession(t.sessionId); } catch { /* best-effort */ }
      }
      // Raw cleanup in case deleteSession wasn't wired or the row is detached.
      this.d.db.prepare('DELETE FROM sessions WHERE id=?').run(t.sessionId);
    }

    // Belt-and-braces: task rows should be gone via cascade, but confirm.
    this.d.db.prepare('DELETE FROM task WHERE topic_id=?').run(topicId);

    if (repo) {
      // The delivery session leaves repo.path checked out on the topic branch;
      // git refuses to delete a branch that's currently HEAD. Switch back to
      // the default branch first so both the topic branch and the per-task
      // branches can be force-deleted cleanly.
      if (topic.topicBranch) {
        try { await this.d.git(['checkout', repo.defaultBranch], repo.path); } catch { /* best-effort */ }
      }
      // Drop every per-task branch (<topic>__<task>, __claudex_fix__<n>, etc.).
      for (const t of siblingTasks) {
        if (t.childBranch && t.childBranch !== topic.topicBranch) {
          try { await this.d.git(['branch', '-D', t.childBranch], repo.path); } catch { /* ignore */ }
        }
      }
      // Drop the topic branch.
      if (topic.topicBranch) {
        try { await this.d.git(['branch', '-D', topic.topicBranch], repo.path); } catch { /* ignore */ }
      }
    }

    this.d.topics.delete(topicId);
  }
}

function orientationHint(args: {
  cwd: string;
  branch: string;
  base: string;
  topicTitle?: string;
  taskLabel?: string | null;
}): string {
  let listing = '';
  try {
    const entries = readdirSync(args.cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length > 0) listing = entries.join(' ');
  } catch { /* best-effort */ }

  const parts = [
    `You are in a fresh git worktree at ${args.cwd}, on branch ${args.branch} cut from ${args.base}.`,
  ];
  if (args.topicTitle) {
    parts.push(`Topic: ${args.topicTitle}${args.taskLabel ? ` — task: ${args.taskLabel}` : ''}.`);
  }
  if (listing) {
    parts.push(`Top-level of the working tree (at spawn time): ${listing}.`);
  }
  parts.push(`The working tree mirrors that base branch, so directory layout may differ from what you've seen on other branches. Always verify paths with \`ls\` / \`git status\` before assuming anything.`);
  return parts.join(' ');
}
