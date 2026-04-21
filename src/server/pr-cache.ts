import type { VcsAdapter, PR, ReviewThread, Check } from './vcs/adapter.js';

export interface PrBundle {
  pr: PR;
  threads: ReviewThread[];
  checks: Check[];
  requiredContexts: string[];
  fetchedAt: number;
}

/**
 * Adapter resolver: legacy callers pass a VcsAdapter instance directly,
 * newer (GitLab-aware) callers pass a function that picks by cwd. PrCache
 * accepts either shape so existing tests / code keep working.
 */
export type AdapterLike = VcsAdapter | ((cwd: string) => VcsAdapter);

export class PrCache {
  private cache = new Map<string, PrBundle>();

  constructor(private adapter: AdapterLike, private ttlMs = 30_000) {}

  private pick(cwd: string): VcsAdapter {
    return typeof this.adapter === 'function' ? this.adapter(cwd) : this.adapter;
  }

  async get(cwd: string, prNumber: number, defaultBranch: string, force = false): Promise<PrBundle> {
    const key = `${cwd}#${prNumber}`;
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.fetchedAt < this.ttlMs) return hit;

    const adapter = this.pick(cwd);
    const pr = await adapter.getPR(cwd, prNumber);
    const [threads, checks, requiredContexts] = await Promise.all([
      adapter.listReviewThreads(cwd, prNumber),
      adapter.listChecks(cwd, pr.headBranch),
      adapter.getRequiredChecks(cwd, defaultBranch),
    ]);

    const bundle: PrBundle = { pr, threads, checks, requiredContexts, fetchedAt: Date.now() };
    this.cache.set(key, bundle);
    return bundle;
  }

  invalidate(cwd: string, prNumber: number): void {
    this.cache.delete(`${cwd}#${prNumber}`);
  }
}
