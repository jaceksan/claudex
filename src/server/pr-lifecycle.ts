import type { RepoStore } from './repo.js';
import type { TopicStore, Topic } from './topic.js';
import type { VcsAdapter } from './vcs/adapter.js';
import type { PrCache } from './pr-cache.js';

export class PrLifecycle {
  constructor(
    private deps: {
      repos: RepoStore;
      topics: TopicStore;
      adapter: (repoId: string) => VcsAdapter;
      prCache: PrCache;
      git: (args: string[], cwd?: string) => Promise<string>;
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
}

function defaultBody(topic: Pick<Topic, 'title' | 'ticketKey'>): string {
  return `## Summary\n\n_TODO_\n\n## Test plan\n\n- [ ] _TODO_\n${topic.ticketKey ? `\nTicket: ${topic.ticketKey}\n` : ''}`;
}
