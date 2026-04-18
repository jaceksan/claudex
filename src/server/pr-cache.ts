import type { VcsAdapter, PR, ReviewThread, Check } from './vcs/adapter.js';

export interface PrBundle {
  pr: PR;
  threads: ReviewThread[];
  checks: Check[];
  requiredContexts: string[];
  fetchedAt: number;
}

export class PrCache {
  private cache = new Map<string, PrBundle>();

  constructor(private adapter: VcsAdapter, private ttlMs = 30_000) {}

  async get(cwd: string, prNumber: number, defaultBranch: string, force = false): Promise<PrBundle> {
    const key = `${cwd}#${prNumber}`;
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.fetchedAt < this.ttlMs) return hit;

    const pr = await this.adapter.getPR(cwd, prNumber);
    const [threads, checks, requiredContexts] = await Promise.all([
      this.adapter.listReviewThreads(cwd, prNumber),
      this.adapter.listChecks(cwd, pr.headBranch),
      this.adapter.getRequiredChecks(cwd, defaultBranch),
    ]);

    const bundle: PrBundle = { pr, threads, checks, requiredContexts, fetchedAt: Date.now() };
    this.cache.set(key, bundle);
    return bundle;
  }

  invalidate(cwd: string, prNumber: number): void {
    this.cache.delete(`${cwd}#${prNumber}`);
  }
}
