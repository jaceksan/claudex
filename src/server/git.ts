import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  detached?: boolean;
  ahead?: number;
  behind?: number;
  upstream?: string;
  dirty?: { staged: number; unstaged: number; untracked: number };
  lastCommit?: { sha: string; subject: string; relative: string };
  remote?: { host: string; owner: string; repo: string };
  pr?: { number: number; title: string; state: string; url: string; checks?: { passing: number; failing: number; pending: number } };
}

async function git(cwd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  // GIT_OPTIONAL_LOCKS=0 prevents status/rev-list probes from taking
  // .git/index.lock on large repos; if the lock is held by Claude's own
  // git command, status degrades gracefully instead of racing and (on
  // timeout) leaving a stale lock behind. 2s was too tight for big repos
  // refreshing a cold index — bumped to 10s so Node no longer SIGKILLs
  // git mid-lock-hold.
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

function parseRemote(url: string): GitInfo['remote'] | undefined {
  // git@github.com:owner/repo.git  |  https://github.com/owner/repo(.git)?
  const ssh = url.match(/^[^@]+@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };
  const https = url.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (https) return { host: https[1], owner: https[2], repo: https[3] };
  return undefined;
}

async function getPr(cwd: string): Promise<GitInfo['pr']> {
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'view', '--json', 'number,title,state,url,statusCheckRollup'],
      { cwd, timeout: 4000, maxBuffer: 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as {
      number: number; title: string; state: string; url: string;
      statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }>;
    };
    let checks: { passing: number; failing: number; pending: number } | undefined;
    const rollup = data.statusCheckRollup;
    if (Array.isArray(rollup) && rollup.length > 0) {
      checks = { passing: 0, failing: 0, pending: 0 };
      for (const c of rollup) {
        const s = (c.conclusion ?? c.state ?? c.status ?? '').toUpperCase();
        if (s === 'SUCCESS') checks.passing++;
        else if (s === 'FAILURE' || s === 'ERROR' || s === 'CANCELLED' || s === 'TIMED_OUT') checks.failing++;
        else checks.pending++;
      }
    }
    return { number: data.number, title: data.title, state: data.state, url: data.url, checks };
  } catch {
    return undefined;
  }
}

export async function getGitInfo(cwd: string): Promise<GitInfo> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { isRepo: false };
  }

  const info: GitInfo = { isRepo: true };

  try {
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch === 'HEAD') {
      info.detached = true;
      info.branch = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
    } else {
      info.branch = branch;
    }
  } catch {/* ignore */}

  try {
    const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    info.upstream = upstream;
    const counts = (await git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim().split(/\s+/);
    info.behind = Number(counts[0] ?? 0);
    info.ahead = Number(counts[1] ?? 0);
  } catch {/* no upstream */}

  try {
    const status = await git(cwd, ['status', '--porcelain=v1']);
    let staged = 0, unstaged = 0, untracked = 0;
    for (const line of status.split('\n')) {
      if (!line) continue;
      if (line.startsWith('??')) { untracked++; continue; }
      const [x, y] = [line[0], line[1]];
      if (x && x !== ' ' && x !== '?') staged++;
      if (y && y !== ' ' && y !== '?') unstaged++;
    }
    info.dirty = { staged, unstaged, untracked };
  } catch {/* ignore */}

  try {
    const log = (await git(cwd, ['log', '-1', '--pretty=%h%x1f%s%x1f%cr'])).trim();
    const [sha, subject, relative] = log.split('\x1f');
    if (sha) info.lastCommit = { sha, subject: subject ?? '', relative: relative ?? '' };
  } catch {/* ignore */}

  try {
    const url = (await git(cwd, ['config', '--get', 'remote.origin.url'])).trim();
    info.remote = parseRemote(url);
  } catch {/* ignore */}

  if (info.remote?.host === 'github.com' && info.branch && !info.detached) {
    info.pr = await getPr(cwd);
  }

  return info;
}
