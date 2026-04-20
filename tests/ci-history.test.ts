import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSchema } from '../src/server/schema';
import { RepoStore } from '../src/server/repo';
import { CiHistoryStore, isFlaky } from '../src/server/ci-history';

describe('CiHistoryStore', () => {
  let db: Database.Database;
  let repos: RepoStore;
  let hist: CiHistoryStore;
  let repoId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);
    repos = new RepoStore(db);
    hist = new CiHistoryStore(db);
    repoId = repos.register({
      path: '/tmp/r', vcsKind: 'github',
      canonicalRemote: 'origin', forkRemote: 'origin', defaultBranch: 'main',
    }).id;
  });

  it('records observations and reads them back most-recent-first', () => {
    hist.record(repoId, 'ci', 1, 100, 'success');
    hist.record(repoId, 'ci', 2, 101, 'failure');
    const samples = hist.recentSamples(repoId, 'ci');
    expect(samples).toHaveLength(2);
    // Most recent insert is first.
    expect(samples[0].conclusion).toBe('failure');
    expect(samples[1].conclusion).toBe('success');
  });

  it('upserts same (pr, run) key instead of inserting duplicates', () => {
    hist.record(repoId, 'ci', 1, 100, 'failure');
    hist.record(repoId, 'ci', 1, 100, 'success');
    const samples = hist.recentSamples(repoId, 'ci');
    expect(samples).toHaveLength(1);
    expect(samples[0].conclusion).toBe('success');
  });

  it('prunes history to cap of 50 samples per (repo, check)', () => {
    for (let i = 0; i < 60; i++) {
      hist.record(repoId, 'ci', i, i, i % 2 === 0 ? 'success' : 'failure');
    }
    const samples = hist.recentSamples(repoId, 'ci', 100);
    expect(samples.length).toBe(50);
  });

  it('classifies a check as flaky when recent history mixes success and failure', () => {
    hist.record(repoId, 'sonar', 1, 100, 'success');
    hist.record(repoId, 'sonar', 2, 101, 'failure');
    hist.record(repoId, 'sonar', 3, 102, 'success');
    expect(hist.flakyChecksForRepo(repoId)).toContain('sonar');
  });

  it('does not flag a check that has only failures', () => {
    hist.record(repoId, 'build', 1, 100, 'failure');
    hist.record(repoId, 'build', 2, 101, 'failure');
    hist.record(repoId, 'build', 3, 102, 'failure');
    expect(hist.flakyChecksForRepo(repoId)).not.toContain('build');
  });

  it('does not flag a check that has only successes', () => {
    hist.record(repoId, 'lint', 1, 100, 'success');
    hist.record(repoId, 'lint', 2, 101, 'success');
    expect(hist.flakyChecksForRepo(repoId)).not.toContain('lint');
  });

  it('ignores skipped / cancelled / neutral when deciding flakiness', () => {
    hist.record(repoId, 'maybe', 1, 100, 'skipped');
    hist.record(repoId, 'maybe', 2, 101, 'cancelled');
    hist.record(repoId, 'maybe', 3, 102, 'success');
    // Only one contributing sample (success) — not flaky.
    expect(hist.flakyChecksForRepo(repoId)).not.toContain('maybe');
  });
});

describe('isFlaky', () => {
  it('empty history is not flaky', () => {
    expect(isFlaky([])).toBe(false);
  });
  it('mixed within window is flaky', () => {
    expect(isFlaky([
      { conclusion: 'success', observedAt: 3, prNumber: 3, runId: 3 },
      { conclusion: 'failure', observedAt: 2, prNumber: 2, runId: 2 },
      { conclusion: 'success', observedAt: 1, prNumber: 1, runId: 1 },
    ])).toBe(true);
  });
  it('old failures outside the 10-sample window are ignored', () => {
    const pass = (i: number) => ({ conclusion: 'success', observedAt: i, prNumber: i, runId: i });
    const fail = (i: number) => ({ conclusion: 'failure', observedAt: i, prNumber: i, runId: i });
    const samples = [
      ...[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(pass), // 10 successes — dominates window
      fail(0),                                       // ancient failure, out of window
    ];
    expect(isFlaky(samples)).toBe(false);
  });
});
