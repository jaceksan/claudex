import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { RepoStore } from './repo.js';
import type { TopicStore, TopicTemplate } from './topic.js';
import type { TaskStore } from './task.js';
import { renderBranchTemplate } from './branch-template.js';
import { slugify } from './slug.js';

export interface SpawnedSession { id: string; }
export type Git = (args: string[], cwd?: string) => Promise<string>;
export type CreateWt = (cwd: string, uiId: string, opts: { branch: string; base?: string }) => { path: string; origin: string; branch: string };

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
    if (topic.phase !== 'Draft') throw new Error(`cannot add attempt: phase ${topic.phase}`);
    if (topic.acceptedAttemptId) throw new Error('cannot add attempt after accept — use fix task');
    const repo = this.d.repos.getById(topic.repoId)!;
    const existing = this.d.tasks.listByTopic(topicId).filter((t) => t.type === 'attempt');

    // Find a free attempt number. Leftover branches from prior partial failures
    // (session spawn crashed after the branch was created, or a prior discard that
    // didn't drop the branch) would otherwise collide with `git worktree add -b`.
    let attemptBranch = '';
    let nStr = '';
    const maxAttempts = existing.length + 50;
    for (let n = existing.length + 1; n <= maxAttempts; n++) {
      nStr = String(n);
      attemptBranch = topic.topicBranch! + renderBranchTemplate(repo.attemptSuffix, { n: nStr });
      // `git branch --list <name>` is empty when the branch doesn't exist.
      const existsOutput = await this.d.git(['branch', '--list', attemptBranch], repo.path);
      if (existsOutput.trim() === '') break;
    }
    if (!attemptBranch) throw new Error('could not find a free attempt branch name');

    // Create the worktree BEFORE spawning so the Claude subprocess's cwd is the worktree,
    // not the source repo. Pre-generate the uiId so the worktree dir name matches the session.
    const presetUiId = randomUUID();
    const wt = this.d.createWorktree(repo.path, presetUiId, { branch: attemptBranch, base: topic.topicBranch! });
    const session = await this.d.spawnSession({
      cwd: wt.path, label: args.label ?? `attempt-${nStr}`,
      prompt: args.prompt, effort: args.effort, permissionMode: args.permissionMode,
      presetUiId, worktree: wt,
      appendSystemPrompt: orientationHint({
        cwd: wt.path, branch: attemptBranch, base: topic.topicBranch!,
        topicTitle: topic.title, taskLabel: args.label ?? `attempt-${nStr}`,
      }),
    });
    return this.d.tasks.create({
      sessionId: session.id, topicId, type: 'attempt',
      label: args.label ?? `attempt-${nStr}`,
      childBranch: attemptBranch, worktreePath: wt.path,
    });
  }

  async acceptAttempt(sessionId: string) {
    const task = this.d.tasks.getBySession(sessionId);
    if (!task) throw new Error(`task ${sessionId} not found`);
    if (task.type !== 'attempt') throw new Error('not an attempt task');
    const topic = this.d.topics.getById(task.topicId)!;
    const repo = this.d.repos.getById(topic.repoId)!;
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

    // Worktree first, spawn inside it.
    const presetUiId = randomUUID();
    const childBranch = `${topic.topicBranch}__fix-${presetUiId.slice(0, 6)}`;
    const wt = this.d.createWorktree(repo.path, presetUiId, { branch: childBranch, base: topic.topicBranch! });
    const session = await this.d.spawnSession({
      cwd: wt.path,
      label: args.label ?? args.type,
      prompt: args.prompt,
      effort: args.effort,
      permissionMode: args.permissionMode,
      presetUiId, worktree: wt,
      appendSystemPrompt: orientationHint({
        cwd: wt.path, branch: childBranch, base: topic.topicBranch!,
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

  async acceptFixTask(sessionId: string) {
    const task = this.d.tasks.getBySession(sessionId);
    if (!task) throw new Error(`task ${sessionId} not found`);
    if (task.type !== 'fix-comments' && task.type !== 'fix-ci') {
      throw new Error('not a fix task');
    }
    if (task.acceptedAt) throw new Error('task already accepted');
    if (task.discardedAt) throw new Error('task already discarded');

    const topic = this.d.topics.getById(task.topicId)!;
    const repo = this.d.repos.getById(topic.repoId)!;

    await this.d.git(['checkout', topic.topicBranch!], repo.path);
    await this.d.git(['merge', '--squash', task.childBranch!], repo.path);

    const subject = task.label ? `fix(pr): ${task.label}` : 'fix(pr): apply review fixes';
    const msg = repo.commitTemplate.replace('{subject}', subject);
    await this.d.git(['commit', '-m', msg], repo.path);

    const commitSha = (await this.d.git(['rev-parse', 'HEAD'], repo.path)).trim();

    await this.d.git(['push', repo.forkRemote, topic.topicBranch!], repo.path);

    if (this.d.prLifecycle) {
      await this.d.prLifecycle.onFixAccepted(topic, task, commitSha);
    }

    this.d.tasks.markAccepted(sessionId);
  }

  async discardFixTask(sessionId: string) {
    const task = this.d.tasks.getBySession(sessionId);
    if (!task) throw new Error(`task ${sessionId} not found`);
    if (task.type !== 'fix-comments' && task.type !== 'fix-ci') {
      throw new Error('not a fix task');
    }
    this.d.tasks.markDiscarded(sessionId);
  }

  async deleteTopic(topicId: string) {
    const topic = this.d.topics.getById(topicId);
    if (!topic) throw new Error(`topic ${topicId} not found`);
    const repo = this.d.repos.getById(topic.repoId);

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

    // Drop the topic branch — best-effort, ignore if it was never created or already gone.
    if (repo && topic.topicBranch) {
      try { await this.d.git(['branch', '-D', topic.topicBranch], repo.path); } catch { /* ignore */ }
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
