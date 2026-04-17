import type Database from 'better-sqlite3';
import type { RepoStore } from './repo';
import type { TopicStore, TopicTemplate } from './topic';
import type { TaskStore } from './task';
import { renderBranchTemplate } from './branch-template';
import { slugify } from './slug';

export interface SpawnedSession { id: string; }
export type Git = (args: string[], cwd?: string) => Promise<string>;
export type CreateWt = (cwd: string, uiId: string, opts: { branch: string; base?: string }) => { path: string; origin: string; branch: string };

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
}
