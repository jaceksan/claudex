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
  spawnSession: (args: { cwd: string; label: string; prompt?: string; effort: string; permissionMode: string }) => Promise<SpawnedSession>;
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
  firstTask: { prompt?: string; effort: string; permissionMode: string; label?: string };
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
      const session = await this.d.spawnSession({
        cwd: repo.path, label: input.firstTask.label ?? 'explore',
        prompt: input.firstTask.prompt, effort: input.firstTask.effort,
        permissionMode: input.firstTask.permissionMode,
      });
      const task = this.d.tasks.create({
        sessionId: session.id, topicId: topic.id, type: 'free', label: 'explore',
      });
      return { topic, task };
    }

    const ghUser = await this.d.githubLogin();
    const branchCtx: Record<string, string> = {
      gh_user: ghUser, ticket: input.ticketKey ?? '', slug,
      type: input.type ?? '', project: input.project ?? '',
    };
    const topicBranch = renderBranchTemplate(repo.branchTemplate, branchCtx);

    await this.d.git(['fetch', repo.canonicalRemote, repo.defaultBranch], repo.path);
    await this.d.git(['branch', topicBranch, `${repo.canonicalRemote}/${repo.defaultBranch}`], repo.path);

    const topic = this.d.topics.create({
      repoId: repo.id, phase: 'Draft', template: input.template,
      title: input.title, slug, ticketKey: input.ticketKey ?? null, topicBranch,
    });

    const attemptBranch = topicBranch + renderBranchTemplate(repo.attemptSuffix, { n: '1' });
    const session = await this.d.spawnSession({
      cwd: repo.path,
      label: input.firstTask.label ?? 'attempt-1',
      prompt: input.firstTask.prompt, effort: input.firstTask.effort,
      permissionMode: input.firstTask.permissionMode,
    });
    const wt = this.d.createWorktree(repo.path, session.id, { branch: attemptBranch, base: topicBranch });
    this.d.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(wt.path, session.id);

    const task = this.d.tasks.create({
      sessionId: session.id, topicId: topic.id, type: 'attempt',
      label: input.firstTask.label ?? 'attempt-1',
      childBranch: attemptBranch, worktreePath: wt.path,
    });
    return { topic, task };
  }

  async addAttempt(topicId: string, args: { prompt?: string; effort: string; permissionMode: string; label?: string }) {
    const topic = this.d.topics.getById(topicId);
    if (!topic) throw new Error(`topic ${topicId} not found`);
    if (topic.phase !== 'Draft') throw new Error(`cannot add attempt: phase ${topic.phase}`);
    if (topic.acceptedAttemptId) throw new Error('cannot add attempt after accept — use fix task');
    const repo = this.d.repos.getById(topic.repoId)!;
    const existing = this.d.tasks.listByTopic(topicId).filter((t) => t.type === 'attempt');
    const n = String(existing.length + 1);
    const attemptBranch = topic.topicBranch! + renderBranchTemplate(repo.attemptSuffix, { n });
    const session = await this.d.spawnSession({
      cwd: repo.path, label: args.label ?? `attempt-${n}`,
      prompt: args.prompt, effort: args.effort, permissionMode: args.permissionMode,
    });
    const wt = this.d.createWorktree(repo.path, session.id, { branch: attemptBranch, base: topic.topicBranch! });
    this.d.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(wt.path, session.id);
    return this.d.tasks.create({
      sessionId: session.id, topicId, type: 'attempt',
      label: args.label ?? `attempt-${n}`,
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

    const session = await this.d.spawnSession({
      cwd: repo.path,
      label: args.label ?? args.type,
      prompt: args.prompt,
      effort: args.effort,
      permissionMode: args.permissionMode,
    });
    const childBranch = `${topic.topicBranch}__fix-${session.id.slice(0, 6)}`;
    const wt = this.d.createWorktree(repo.path, session.id, { branch: childBranch, base: topic.topicBranch! });
    this.d.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(wt.path, session.id);
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
}
