export type TopicClientMessage =
  | { type: 'client.topic.create'; payload: {
      repoId: string;
      template: 'quick-fix' | 'standard' | 'exploration';
      title: string;
      ticketKey?: string;
      typeField?: string;
      project?: string;
      branchOverride?: string;
    } }
  | { type: 'client.topic.addAttempt'; payload: { topicId: string; prompt?: string; effort: string; permissionMode: string; label?: string } }
  | { type: 'client.topic.list'; payload: { repoId?: string } }
  | { type: 'client.topic.delete'; payload: { topicId: string } }
  | { type: 'client.topic.previewBranch'; payload: { repoId: string; title: string; ticketKey?: string; override?: string } }
  | { type: 'client.topic.subscribe'; payload: { topicId: string } }
  | { type: 'client.topic.unsubscribe'; payload: { topicId: string } }
  | { type: 'client.topic.push'; payload: { topicId: string } }
  | { type: 'client.task.save'; payload: { sessionId: string; message?: string } }
  | { type: 'client.task.discardChanges'; payload: { sessionId: string } }
  | { type: 'client.task.discardHard'; payload: { sessionId: string } }
  | { type: 'client.task.merge'; payload: { sessionId: string } }
  | { type: 'client.repo.list'; payload: Record<string, never> }
  | { type: 'client.pr.create'; payload: { topicId: string; title?: string; body?: string } }
  | { type: 'client.pr.addressFeedback'; payload: { topicId: string; includeCi: boolean; includeComments: boolean } }
  | { type: 'client.pr.fixComment'; payload: { topicId: string; threadId: string } }
  | { type: 'client.pr.fixCheck'; payload: { topicId: string; checkName: string } }
  | { type: 'client.pr.watch'; payload: { topicId: string; enable: boolean } }
  | { type: 'client.thread.reply'; payload: { topicId: string; threadId: string; body: string } }
  | { type: 'client.session.siblings'; payload: { sessionId: string } };

export type TopicServerMessage =
  | { type: 'server.topic.state'; payload: { topics: TopicCard[] } }
  | { type: 'server.topic.created'; payload: { topicId: string } }
  | { type: 'server.topic.error'; payload: { message: string; ctx?: string } }
  | { type: 'server.repo.state'; payload: { repos: RepoRow[] } }
  | { type: 'server.topic.detail'; payload: TopicDetailBundle }
  | { type: 'server.topic.branchPreview'; payload: {
      branch: string;
      localBranchExists: boolean;
      duplicateTopic: { id: string; title: string } | null;
    } }
  | { type: 'server.session.siblings'; payload: { sessionId: string; topicId: string | null; siblings: SiblingRow[] } };

export interface SiblingRow {
  sessionId: string;
  topicId: string;
  type: string;
  label: string | null;
  title: string | null;
  cwd: string;
  status: string;
  lastActivityAt: number;
  acceptedAt: number | null;
  discardedAt: number | null;
}

export interface TopicCard {
  id: string;
  repoId: string;
  /** Short repo name (last path segment) — used to label cards on the dashboard. */
  repoName: string;
  phase: string;
  template: string;
  ticketKey: string | null;
  title: string;
  topicBranch: string | null;
  prNumber: number | null;
  taskSummary: { running: number; accepted: number; discarded: number };
  lastEventAt: number;
}

export interface TaskRow {
  sessionId: string;
  topicId: string;
  type: string;
  label: string | null;
  childBranch: string | null;
  acceptedAt: number | null;
  discardedAt: number | null;
  sessionStatus: string;
}

export interface TopicDetailBundle {
  topicId: string;
  topic: TopicCard & {
    acceptedAttemptId: string | null;
    watchCi: boolean;
    slug: string;
    repoPath: string;
    repoDefaultBranch: string;
    /**
     * True when the topic branch has commits that aren't yet on the fork
     * remote (or the branch has never been pushed). Drives Push-button
     * visibility so we don't offer the action when there's nothing to push.
     */
    canPush: boolean;
  };
  tasks: TaskRow[];
  pr?: import('../vcs/adapter.js').PR;
  threads?: import('../vcs/adapter.js').ReviewThread[];
  checks?: import('../vcs/adapter.js').Check[];
  required?: string[];
}

export interface RepoRow {
  id: string;
  path: string;
  vcsKind: 'github' | 'gitlab';
  defaultBranch: string;
  canonicalOwner: string | null;
  canonicalName: string | null;
}
