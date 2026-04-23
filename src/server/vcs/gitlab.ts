import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VcsAdapter, PR, RepoSummary, ReviewThread, Check } from './adapter.js';

/**
 * GitLab adapter over the `glab` CLI. **Preview / unfinished.** The
 * interface shape is the same as GitHubAdapter so the rest of claudex can
 * treat the two uniformly; the individual methods below are best-effort
 * mappings of the most common glab commands and have not been run against
 * a real GitLab instance in this repo yet. Expect papercuts; please file
 * issues with actual glab output if you hit them.
 */
const execFileP = promisify(execFile);

export type Exec = (file: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

const defaultExec: Exec = async (file, args, opts) => {
  const { stdout } = await execFileP(file, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

export class GitLabAdapter implements VcsAdapter {
  readonly kind = 'gitlab' as const;
  private exec: Exec;
  constructor(opts: { exec?: Exec } = {}) { this.exec = opts.exec ?? defaultExec; }

  private async glab(args: string[], cwd?: string): Promise<string> {
    return this.exec('glab', args, { cwd });
  }

  async getCurrentUser(): Promise<{ login: string }> {
    // `glab auth status` prints "Logged in to gitlab.com as <user>" on stderr; the
    // cleanest scriptable path is `glab api user --hostname gitlab.com`.
    const out = await this.glab(['api', 'user']);
    const j = JSON.parse(out);
    return { login: j.username ?? '' };
  }

  async getRepo(cwd: string): Promise<RepoSummary> {
    const out = await this.glab(['repo', 'view', '--output', 'json'], cwd);
    const j = JSON.parse(out);
    return {
      owner: j.namespace?.path ?? '', name: j.path ?? '',
      defaultBranch: j.default_branch ?? 'main',
      parentOwner: j.forked_from_project?.namespace?.path,
      parentName: j.forked_from_project?.path,
    };
  }

  async getPR(cwd: string, n: number): Promise<PR> {
    const out = await this.glab(['mr', 'view', String(n), '--output', 'json'], cwd);
    const j = JSON.parse(out);
    return {
      number: j.iid ?? n, url: j.web_url ?? '', title: j.title ?? '', body: j.description ?? '',
      state: j.state ?? '',
      baseBranch: j.target_branch ?? '', headBranch: j.source_branch ?? '',
      author: j.author?.username ?? '',
      mergeable: j.merge_status === 'can_be_merged' ? true : j.merge_status === 'cannot_be_merged' ? false : null,
      approvalsCount: 0, // TODO: map from approvals API
      requiredApprovals: 1,
      // GitLab doesn't expose an equivalent single-flag rollup here; leave
      // null and let the UI fall back to its local check-run view.
      statusCheckRollup: null,
    };
  }

  async findPrByHead(cwd: string, branch: string): Promise<number | null> {
    try {
      const out = await this.glab(['mr', 'list', '--source-branch', branch, '--state', 'opened', '--output', 'json'], cwd);
      const arr = JSON.parse(out) as Array<{ iid: number }>;
      return arr.length > 0 ? arr[0].iid : null;
    } catch { return null; }
  }

  async createPR(input: { cwd: string; base: string; head: string; title: string; body: string }): Promise<PR> {
    // glab mr create prints the MR URL on stdout.
    const out = await this.glab([
      'mr', 'create',
      '--target-branch', input.base, '--source-branch', input.head,
      '--title', input.title, '--description', input.body,
      '--fill-commit-body',
    ], input.cwd);
    const m = out.match(/\/merge_requests\/(\d+)/);
    if (!m) throw new Error(`glab mr create returned unexpected output: ${out.trim()}`);
    return this.getPR(input.cwd, Number(m[1]));
  }

  async mergePR(cwd: string, n: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void> {
    const args = ['mr', 'merge', String(n), '--yes'];
    if (strategy === 'squash') args.push('--squash');
    if (strategy === 'rebase') args.push('--rebase');
    await this.glab(args, cwd);
  }

  async listReviewThreads(_cwd: string, _n: number): Promise<ReviewThread[]> {
    // glab has `mr note` but not an obvious resolved-threads mapping. Return
    // empty for now so the rest of the UI stays functional; the CommentsPanel
    // will simply show "no unresolved comments".
    return [];
  }
  async replyOnThread(_cwd: string, _threadId: string, _body: string): Promise<void> {
    throw new Error('GitLab: replyOnThread not yet implemented.');
  }
  async resolveThread(_cwd: string, _threadId: string): Promise<void> {
    throw new Error('GitLab: resolveThread not yet implemented.');
  }

  async listChecks(cwd: string, ref: string): Promise<Check[]> {
    // Map GitLab pipeline jobs → Check. `glab ci status` gives a summary; we
    // want per-job detail via `glab api /projects/:id/pipelines/:id/jobs`.
    // For now we surface whatever `glab ci status --output json` returns.
    try {
      const out = await this.glab(['ci', 'status', '--branch', ref, '--output', 'json'], cwd);
      const arr = JSON.parse(out) as Array<{ id: number; name: string; status: string; web_url?: string; started_at?: string | null; finished_at?: string | null }>;
      return arr.map((j): Check => ({
        name: j.name,
        status: j.status === 'success' || j.status === 'failed' || j.status === 'canceled' || j.status === 'skipped' ? 'completed' : 'in_progress',
        conclusion: j.status === 'success' ? 'success' : j.status === 'failed' ? 'failure' : j.status === 'skipped' ? 'skipped' : j.status === 'canceled' ? 'cancelled' : null,
        runId: j.id, url: j.web_url ?? '',
        startedAt: j.started_at ? Date.parse(j.started_at) || null : null,
        completedAt: j.finished_at ? Date.parse(j.finished_at) || null : null,
      }));
    } catch { return []; }
  }
  async getRequiredChecks(_cwd: string, _branch: string): Promise<string[]> {
    // GitLab doesn't have a direct equivalent of GitHub's required status
    // contexts; "protected branch" rules are per-project. Returning [] is
    // equivalent to "no required checks configured" — everything lands in
    // Advisory until a GitLab-specific rule is wired.
    return [];
  }
  async rerunFailedChecks(cwd: string, runId: number): Promise<void> {
    await this.glab(['ci', 'retry', String(runId)], cwd);
  }
  async rerunRun(cwd: string, runId: number): Promise<void> {
    await this.glab(['ci', 'retry', String(runId)], cwd);
  }
  async listCollaborators(_cwd: string): Promise<{ login: string; name?: string }[]> {
    // `glab repo members` exists but output shape varies across versions.
    // Return empty until someone wires it end-to-end against a real project.
    return [];
  }
}
