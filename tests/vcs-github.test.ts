import { describe, it, expect } from 'vitest';
import { GitHubAdapter } from '../src/server/vcs/github';
import { readFileSync } from 'node:fs';

function stubExec(mapping: Record<string, string>): (file: string, args: string[]) => Promise<string> {
  return async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    for (const [pattern, output] of Object.entries(mapping)) {
      if (key.includes(pattern)) return output;
    }
    throw new Error(`unexpected exec call: ${key}`);
  };
}

function fx(name: string): string {
  return readFileSync(`tests/fixtures/gh-output/${name}`, 'utf8');
}

describe('GitHubAdapter', () => {
  it('getCurrentUser returns trimmed login', async () => {
    const a = new GitHubAdapter({ exec: stubExec({ 'api user': 'jaceksan\n' }) });
    expect(await a.getCurrentUser()).toEqual({ login: 'jaceksan' });
  });

  it('getRepo parses a direct-owned repo (no fork parent)', async () => {
    const a = new GitHubAdapter({ exec: stubExec({ 'repo view': fx('repo-view.json') }) });
    const r = await a.getRepo('/tmp/r');
    expect(r.owner).toBe('acme');
    expect(r.defaultBranch).toBe('main');
    expect(r.parentOwner).toBeUndefined();
  });

  it('getRepo parses a fork with parent', async () => {
    const a = new GitHubAdapter({ exec: stubExec({ 'repo view': fx('repo-view-fork.json') }) });
    const r = await a.getRepo('/tmp/r');
    expect(r.owner).toBe('jaceksan');
    expect(r.parentOwner).toBe('acme');
    expect(r.parentName).toBe('repo');
  });

  it('getPR parses gh pr view JSON', async () => {
    const a = new GitHubAdapter({ exec: stubExec({ 'pr view': fx('pr-view.json') }) });
    const pr = await a.getPR('/tmp/r', 4711);
    expect(pr.number).toBe(4711);
    expect(pr.state).toBe('OPEN');
    expect(pr.headBranch).toBe('jaceksan/ABC-123_fix-login');
    expect(pr.author).toBe('jaceksan');
    expect(pr.mergeable).toBe(true);
    // When the GraphQL rollup call isn't stubbed, getPR falls back to null
    // rather than propagating the error — callers treat null as "unknown".
    expect(pr.statusCheckRollup).toBeNull();
  });

  it('getPR populates statusCheckRollup from GraphQL when available', async () => {
    const a = new GitHubAdapter({
      exec: stubExec({
        'pr view': fx('pr-view.json'),
        'repo view': fx('repo-view.json'),
        'api graphql': fx('status-check-rollup-pending.json'),
      }),
    });
    const pr = await a.getPR('/tmp/r', 4711);
    // PENDING means a check-suite is queued but has not emitted any
    // check-runs yet — the UI uses this to avoid claiming "all passing"
    // while CI is still spinning up.
    expect(pr.statusCheckRollup).toBe('PENDING');
  });

  it('listReviewThreads maps GraphQL response to ReviewThread[]', async () => {
    const a = new GitHubAdapter({
      exec: stubExec({
        'repo view': fx('repo-view.json'),
        'api graphql': fx('review-threads.json'),
      }),
    });
    const threads = await a.listReviewThreads('/tmp/r', 4711);
    expect(threads).toHaveLength(2);
    expect(threads[0].id).toBe('thread-1');
    expect(threads[0].isResolved).toBe(false);
    expect(threads[0].comments[0].path).toBe('a.ts');
    expect(threads[0].comments[0].line).toBe(42);
    expect(threads[0].comments[0].isBot).toBe(false);
    expect(threads[1].isResolved).toBe(true);
    expect(threads[1].comments[0].isBot).toBe(true);
  });

  it('listChecks maps check-runs API', async () => {
    const a = new GitHubAdapter({ exec: stubExec({ 'check-runs': fx('check-runs.json') }) });
    const checks = await a.listChecks('/tmp/r', 'main');
    expect(checks).toHaveLength(2);
    expect(checks[0].name).toBe('build');
    expect(checks[0].conclusion).toBe('success');
    expect(checks[1].status).toBe('in_progress');
    expect(checks[1].conclusion).toBeNull();
    expect(checks[0].completedAt).not.toBeNull();
  });

  it('getRequiredChecks returns contexts', async () => {
    const a = new GitHubAdapter({ exec: stubExec({ 'protection/required_status_checks': fx('required-checks.json') }) });
    expect(await a.getRequiredChecks('/tmp/r', 'main')).toEqual(['build', 'test']);
  });

  it('getRequiredChecks returns [] on 404/403', async () => {
    const a = new GitHubAdapter({ exec: async () => { throw new Error('HTTP 404'); } });
    expect(await a.getRequiredChecks('/tmp/r', 'main')).toEqual([]);
  });
});
