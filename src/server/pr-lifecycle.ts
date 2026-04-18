import type { RepoStore } from './repo.js';
import type { TopicStore, Topic } from './topic.js';
import type { VcsAdapter } from './vcs/adapter.js';
import type { PrCache } from './pr-cache.js';
import { renderActionPrompt } from './skill-invoker.js';

/** Narrow interface to avoid circular import with topic-manager. */
export interface FixTaskAdder {
  addFixTask(
    topicId: string,
    args: {
      type: 'fix-comments' | 'fix-ci';
      prompt: string;
      effort: string;
      permissionMode: string;
      label?: string;
      parentTrigger?: unknown;
    }
  ): Promise<{ sessionId: string }>;
}

export class PrLifecycle {
  constructor(
    private deps: {
      repos: RepoStore;
      topics: TopicStore;
      adapter: (repoId: string) => VcsAdapter;
      prCache: PrCache;
      git: (args: string[], cwd?: string) => Promise<string>;
      topicManager: FixTaskAdder;
    }
  ) {}

  async createPR(topicId: string, args: { title?: string; body?: string }): Promise<number> {
    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    if (!topic.topicBranch) throw new Error('topic has no branch');
    if (topic.phase !== 'Draft') throw new Error(`cannot create PR in phase ${topic.phase}`);
    await this.deps.git(['push', repo.forkRemote, topic.topicBranch], repo.path);
    const adapter = this.deps.adapter(repo.id);
    const title = args.title ?? `${topic.ticketKey ? topic.ticketKey + ': ' : ''}${topic.title}`;
    const body = args.body ?? (repo.prBodyTemplate ?? defaultBody(topic));
    const pr = await adapter.createPR({ cwd: repo.path, base: repo.defaultBranch, head: topic.topicBranch, title, body });
    this.deps.topics.setPhase(topicId, 'Open', { prNumber: pr.number });
    return pr.number;
  }

  async addressFeedback(
    topicId: string,
    opts: { includeCi: boolean; includeComments: boolean }
  ): Promise<{ sessionId: string }> {
    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    const bundle = await this.deps.prCache.get(repo.path, topic.prNumber!, repo.defaultBranch);

    const threads = opts.includeComments
      ? bundle.threads.filter((t) => !t.isResolved && t.comments.some((c) => !c.isBot))
      : [];

    const failingRequired = opts.includeCi
      ? bundle.checks.filter(
          (c) => c.conclusion === 'failure' && bundle.requiredContexts.includes(c.name)
        )
      : [];

    if (threads.length === 0 && failingRequired.length === 0) {
      throw new Error('nothing to address');
    }

    const prompt = renderActionPrompt({
      action: threads.length ? 'pr-fix' : 'ci-watch',
      skills: repo.skills,
      fixCtx: {
        threads: threads.flatMap((t) =>
          t.comments
            .filter((c) => !c.isBot)
            .map((c) => ({ id: t.id, path: c.path, line: c.line, body: c.body }))
        ),
        checks: await Promise.all(
          failingRequired.map(async (c) => ({
            name: c.name,
            logTail: await this.deps
              .git(['run', 'view', String(c.runId), '--log-failed'], repo.path)
              .catch(() => ''),
          }))
        ),
      },
    });

    const result = await this.deps.topicManager.addFixTask(topicId, {
      type: threads.length ? 'fix-comments' : 'fix-ci',
      prompt,
      effort: 'high',
      permissionMode: 'acceptEdits',
      parentTrigger: {
        threadIds: threads.map((t) => t.id),
        checkNames: failingRequired.map((c) => c.name),
      },
    });

    return { sessionId: result.sessionId };
  }

  async fixComment(topicId: string, threadId: string): Promise<{ sessionId: string }> {
    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    const bundle = await this.deps.prCache.get(repo.path, topic.prNumber!, repo.defaultBranch);

    const thread = bundle.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`thread ${threadId} not found`);

    const prompt = renderActionPrompt({
      action: 'pr-fix',
      skills: repo.skills,
      fixCtx: {
        threads: thread.comments
          .filter((c) => !c.isBot)
          .map((c) => ({ id: thread.id, path: c.path, line: c.line, body: c.body })),
      },
    });

    const result = await this.deps.topicManager.addFixTask(topicId, {
      type: 'fix-comments',
      prompt,
      effort: 'high',
      permissionMode: 'acceptEdits',
      parentTrigger: { threadIds: [threadId] },
    });

    return { sessionId: result.sessionId };
  }

  async fixCheck(topicId: string, checkName: string): Promise<{ sessionId: string }> {
    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    const bundle = await this.deps.prCache.get(repo.path, topic.prNumber!, repo.defaultBranch);

    const check = bundle.checks.find((c) => c.name === checkName);
    if (!check) throw new Error(`check ${checkName} not found`);

    const logTail = await this.deps
      .git(['run', 'view', String(check.runId), '--log-failed'], repo.path)
      .catch(() => '');

    const prompt = renderActionPrompt({
      action: 'ci-watch',
      skills: repo.skills,
      fixCtx: {
        checks: [{ name: check.name, logTail }],
      },
    });

    const result = await this.deps.topicManager.addFixTask(topicId, {
      type: 'fix-ci',
      prompt,
      effort: 'high',
      permissionMode: 'acceptEdits',
      parentTrigger: { checkNames: [checkName] },
    });

    return { sessionId: result.sessionId };
  }
}

function defaultBody(topic: Pick<Topic, 'title' | 'ticketKey'>): string {
  return `## Summary\n\n_TODO_\n\n## Test plan\n\n- [ ] _TODO_\n${topic.ticketKey ? `\nTicket: ${topic.ticketKey}\n` : ''}`;
}
