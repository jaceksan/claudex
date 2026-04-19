export interface RepoSummary {
  owner: string;
  name: string;
  defaultBranch: string;
  parentOwner?: string;
  parentName?: string;
}

export interface PR {
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  baseBranch: string;
  headBranch: string;
  author: string;
  mergeable: boolean | null;
  approvalsCount: number;
  requiredApprovals: number;
}

export interface ReviewThreadComment {
  author: string;
  isBot: boolean;
  body: string;
  path: string | null;
  line: number | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: ReviewThreadComment[];
}

export interface Check {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'neutral' | null;
  runId: number;
  url: string;
  startedAt: number | null;
  completedAt: number | null;
}

export interface VcsAdapter {
  kind: 'github' | 'gitlab';
  getCurrentUser(): Promise<{ login: string }>;
  getRepo(cwd: string): Promise<RepoSummary>;
  createPR(input: {
    cwd: string;
    base: string;
    head: string;
    title: string;
    body: string;
  }): Promise<PR>;
  getPR(cwd: string, number: number): Promise<PR>;
  /** Return the PR number of an open PR on `branch`, or null if none. */
  findPrByHead(cwd: string, branch: string): Promise<number | null>;
  mergePR(cwd: string, number: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void>;
  listReviewThreads(cwd: string, number: number): Promise<ReviewThread[]>;
  replyOnThread(cwd: string, threadId: string, body: string): Promise<void>;
  resolveThread(cwd: string, threadId: string): Promise<void>;
  listChecks(cwd: string, ref: string): Promise<Check[]>;
  getRequiredChecks(cwd: string, branch: string): Promise<string[]>;
  rerunFailedChecks(cwd: string, runId: number): Promise<void>;
  listCollaborators(cwd: string): Promise<{ login: string; name?: string }[]>;
}
