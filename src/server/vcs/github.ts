import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VcsAdapter, PR, RepoSummary, ReviewThread, Check } from './adapter';

const execFileP = promisify(execFile);

export type Exec = (file: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

const defaultExec: Exec = async (file, args, opts) => {
  const { stdout } = await execFileP(file, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

export class GitHubAdapter implements VcsAdapter {
  readonly kind = 'github' as const;
  private exec: Exec;
  constructor(opts: { exec?: Exec } = {}) { this.exec = opts.exec ?? defaultExec; }

  private async gh(args: string[], cwd?: string): Promise<string> {
    return this.exec('gh', args, { cwd });
  }

  async getCurrentUser(): Promise<{ login: string }> {
    const out = await this.gh(['api', 'user', '--jq', '.login']);
    return { login: out.trim() };
  }

  async getRepo(cwd: string): Promise<RepoSummary> {
    const out = await this.gh(['repo', 'view', '--json', 'owner,name,defaultBranchRef,parent'], cwd);
    const j = JSON.parse(out);
    return {
      owner: j.owner.login, name: j.name,
      defaultBranch: j.defaultBranchRef.name,
      parentOwner: j.parent?.owner?.login, parentName: j.parent?.name,
    };
  }

  async getPR(cwd: string, n: number): Promise<PR> {
    const out = await this.gh(['pr', 'view', String(n),
      '--json', 'number,url,title,body,state,baseRefName,headRefName,author,mergeable,reviewDecision'], cwd);
    const j = JSON.parse(out);
    return {
      number: j.number, url: j.url, title: j.title, body: j.body, state: j.state,
      baseBranch: j.baseRefName, headBranch: j.headRefName,
      author: j.author?.login ?? '', mergeable: j.mergeable === 'MERGEABLE' ? true : j.mergeable === 'CONFLICTING' ? false : null,
      approvalsCount: 0, requiredApprovals: j.reviewDecision === 'APPROVED' ? 0 : 1,
    };
  }

  async createPR(input: { cwd: string; base: string; head: string; title: string; body: string }): Promise<PR> {
    const out = await this.gh(['pr', 'create', '--base', input.base, '--head', input.head,
      '--title', input.title, '--body', input.body, '--json', 'number'], input.cwd);
    const j = JSON.parse(out);
    return this.getPR(input.cwd, j.number);
  }

  async mergePR(cwd: string, n: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void> {
    const flag = strategy === 'squash' ? '--squash' : strategy === 'rebase' ? '--rebase' : '--merge';
    await this.gh(['pr', 'merge', String(n), flag, '--delete-branch'], cwd);
  }

  async listReviewThreads(cwd: string, n: number): Promise<ReviewThread[]> {
    const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:10){nodes{body path line:originalLine author{login ... on Bot{id} ... on User{id}}}}}}}}}`;
    const repo = await this.getRepo(cwd);
    const out = await this.gh(['api', 'graphql', '-f', `query=${query}`,
      '-f', `owner=${repo.owner}`, '-f', `repo=${repo.name}`, '-F', `number=${n}`], cwd);
    const j = JSON.parse(out);
    return (j.data.repository.pullRequest.reviewThreads.nodes as Array<{ id: string; isResolved: boolean; comments: { nodes: Array<{ body: string; path: string | null; line: number | null; author?: { login: string; id?: string } | null }> } }>).map((t) => ({
      id: t.id, isResolved: t.isResolved,
      comments: t.comments.nodes.map((c) => ({
        author: c.author?.login ?? '', isBot: !!c.author && !c.author.id, body: c.body,
        path: c.path ?? null, line: c.line ?? null,
      })),
    }));
  }

  async replyOnThread(cwd: string, threadId: string, body: string): Promise<void> {
    const mutation = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}`;
    await this.gh(['api', 'graphql', '-f', `query=${mutation}`, '-f', `threadId=${threadId}`, '-f', `body=${body}`], cwd);
  }

  async resolveThread(cwd: string, threadId: string): Promise<void> {
    const m = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}`;
    await this.gh(['api', 'graphql', '-f', `query=${m}`, '-f', `threadId=${threadId}`], cwd);
  }

  async listChecks(cwd: string, ref: string): Promise<Check[]> {
    const out = await this.gh(['api', `repos/{owner}/{repo}/commits/${ref}/check-runs`], cwd);
    const j = JSON.parse(out);
    return (j.check_runs as Array<{ name: string; status: Check['status']; conclusion: Check['conclusion']; id: number; html_url: string; started_at: string | null; completed_at: string | null }>).map((r) => ({
      name: r.name, status: r.status, conclusion: r.conclusion,
      runId: r.id, url: r.html_url,
      startedAt: r.started_at ? Date.parse(r.started_at) : null,
      completedAt: r.completed_at ? Date.parse(r.completed_at) : null,
    }));
  }

  async getRequiredChecks(cwd: string, branch: string): Promise<string[]> {
    try {
      const out = await this.gh(['api', `repos/{owner}/{repo}/branches/${branch}/protection/required_status_checks`], cwd);
      const j = JSON.parse(out);
      return j.contexts ?? [];
    } catch { return []; }
  }

  async rerunFailedChecks(cwd: string, runId: number): Promise<void> {
    await this.gh(['run', 'rerun', String(runId), '--failed'], cwd);
  }

  async listCollaborators(cwd: string): Promise<{ login: string; name?: string }[]> {
    const out = await this.gh(['api', 'repos/{owner}/{repo}/collaborators', '--paginate'], cwd);
    return (JSON.parse(out) as Array<{ login: string; name?: string }>).map((c) => ({ login: c.login, name: c.name }));
  }
}
