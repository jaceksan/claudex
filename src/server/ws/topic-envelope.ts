export type TopicClientMessage =
  | { type: 'client.topic.create'; payload: {
      repoId: string;
      template: 'quick-fix' | 'standard' | 'exploration';
      title: string;
      ticketKey?: string;
      typeField?: string;
      project?: string;
      firstTask: { prompt?: string; effort: string; permissionMode: string; label?: string };
    } }
  | { type: 'client.topic.addAttempt'; payload: { topicId: string; prompt?: string; effort: string; permissionMode: string; label?: string } }
  | { type: 'client.topic.accept'; payload: { sessionId: string } }
  | { type: 'client.topic.discard'; payload: { sessionId: string } }
  | { type: 'client.topic.list'; payload: { repoId?: string } }
  | { type: 'client.repo.list'; payload: Record<string, never> };

export type TopicServerMessage =
  | { type: 'server.topic.state'; payload: { topics: TopicCard[] } }
  | { type: 'server.topic.created'; payload: { topicId: string; sessionId: string } }
  | { type: 'server.topic.error'; payload: { message: string; ctx?: string } }
  | { type: 'server.repo.state'; payload: { repos: RepoRow[] } };

export interface TopicCard {
  id: string;
  repoId: string;
  phase: string;
  template: string;
  ticketKey: string | null;
  title: string;
  topicBranch: string | null;
  prNumber: number | null;
  taskSummary: { running: number; accepted: number; discarded: number };
  lastEventAt: number;
}

export interface RepoRow {
  id: string;
  path: string;
  vcsKind: 'github' | 'gitlab';
  defaultBranch: string;
  canonicalOwner: string | null;
  canonicalName: string | null;
}
