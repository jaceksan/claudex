import type { RepoStore } from './repo.js';
import type { TopicStore, Topic } from './topic.js';
import type { Task } from './task.js';
import type { VcsAdapter } from './vcs/adapter.js';
import type { PrCache, PrBundle } from './pr-cache.js';
import type { CiRollupState } from './notifications.js';
import type { CiHistoryStore } from './ci-history.js';
import { renderActionPrompt } from './skill-invoker.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Fetch the failed-job log tail for a CI run via `gh`. Returns '' on any
 * failure (no runId, gh missing, timeout, no permission). Kept local to
 * pr-lifecycle because both fixCheck and addressFeedback need it. */
async function fetchFailedLog(cwd: string, runId: number | null | undefined): Promise<string> {
  if (!runId) return '';
  const { stdout } = await execFileP('gh',
    ['run', 'view', String(runId), '--log-failed'],
    { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout.length > 20_000 ? stdout.slice(-20_000) : stdout;
}

/** Narrow interface to avoid circular import with topic-manager. */
export interface FixTaskAdder {
  addFixTask(
    topicId: string,
    args: {
      type: 'fix-comments' | 'fix-ci';
      prompt: string;
      effort: string;
      permissionMode: string;
      label?: string;
      parentTrigger?: unknown;
    }
  ): Promise<{ sessionId: string }>;
}

/** Narrow interface for CI notification — avoids importing the full NotificationEngine. */
export interface CiNotifier {
  ciStateChanged(topic: { id: string; title: string }, prev: CiRollupState, curr: CiRollupState): void;
}

/**
 * Derive a simple 3-state rollup from a PR bundle's required checks,
 * filtering out names the user has marked non-voting for the repo so a
 * known-flaky required check doesn't keep firing "CI failed" notifications.
 */
export function ciRollup(bundle: PrBundle, nonVotingChecks: readonly string[] = []): CiRollupState {
  const required = bundle.checks.filter(
    (c) => bundle.requiredContexts.includes(c.name) && !nonVotingChecks.includes(c.name),
  );
  if (required.length === 0) return 'running'; // no info yet — treat as pending
  if (required.some((c) => c.conclusion === 'failure')) return 'failed';
  if (required.every((c) => c.conclusion === 'success')) return 'ok';
  return 'running'; // some pending / in_progress
}

export class PrLifecycle {
  /** In-memory map of active CI poll intervals keyed by topicId. */
  private readonly ciPollers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Injectable timer functions — overridden in tests via fake timers or by
   * passing explicit replacements to keep intervals from leaking.
   */
  private _setInterval: typeof setInterval;
  private _clearInterval: typeof clearInterval;
  private _setTimeout: typeof setTimeout;
  private _clearTimeout: typeof clearTimeout;

  constructor(
    private deps: {
      repos: RepoStore;
      topics: TopicStore;
      adapter: (repoId: string) => VcsAdapter;
      prCache: PrCache;
      git: (args: string[], cwd?: string) => Promise<string>;
      topicManager: FixTaskAdder;
      notifications?: CiNotifier;
      /** Optional CI history recorder — each poll tick writes observed check conclusions so we can classify flakes. */
      ciHistory?: CiHistoryStore;
      /** Called after any PR-related state change so the hub can re-broadcast the topic detail. */
      onTopicChanged?: (topicId: string) => void;
      /** Override setInterval for tests. Defaults to global setInterval. */
      setInterval?: typeof setInterval;
      /** Override clearInterval for tests. Defaults to global clearInterval. */
      clearInterval?: typeof clearInterval;
      /** Override setTimeout for tests. Defaults to global setTimeout. */
      setTimeout?: typeof setTimeout;
      /** Override clearTimeout for tests. Defaults to global clearTimeout. */
      clearTimeout?: typeof clearTimeout;
    }
  ) {
    this._setInterval = deps.setInterval ?? setInterval;
    this._clearInterval = deps.clearInterval ?? clearInterval;
    this._setTimeout = deps.setTimeout ?? setTimeout;
    this._clearTimeout = deps.clearTimeout ?? clearTimeout;
  }

  /**
   * Legacy auto-PR path, still used by quick-fix-auto on session success.
   * The user-facing Create PR button uses src/server/ops/git-ops +
   * ops/text-gen now; this helper should be migrated too but is left as-is
   * for now (hits the same `_TODO_` template body problem — acceptable for
   * quick-fix because a follow-up human review is expected).
   */
  async createPR(topicId: string, args: { title?: string; body?: string }): Promise<number> {
    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    if (!topic.topicBranch) throw new Error('topic has no branch');
    if (topic.phase !== 'Draft') throw new Error(`cannot create PR in phase ${topic.phase}`);
    await this.deps.git(['push', repo.forkRemote, topic.topicBranch], repo.path);
    const adapter = this.deps.adapter(repo.id);
    const title = args.title ?? `${topic.ticketKey ? topic.ticketKey + ': ' : ''}${topic.title}`;
    const body = args.body ?? (repo.prBodyTemplate ?? defaultBody(topic));
    const pr = await adapter.createPR({ cwd: repo.path, base: repo.defaultBranch, head: topic.topicBranch, title, body });
    this.deps.topics.setPhase(topicId, 'Open', { prNumber: pr.number });

    // Notify subscribers so the topic page can show the new prNumber / PR link
    // without waiting for the first CI poll tick.
    this.deps.onTopicChanged?.(topicId);

    // Auto-enable CI watch after creating a PR.
    await this.watchCi(topicId, true);

    return pr.number;
  }

  /**
   * Enable or disable the CI poll watcher for a topic.
   *
   * When enabled, polls prCache every 2 minutes and fires a ciStateChanged
   * OS notification on rollup transitions (running→ok, running→failed,
   * failed→ok, etc.).
   *
   * Disabling clears the interval and persists watch_ci=0.
   *
   * Note: auto-disable on PR merge/close is not wired here.  Call
   * stopWatch(topicId) from the PR-merge handler added in Plan 4.
   */
  async watchCi(topicId: string, enable: boolean): Promise<void> {
    this.deps.topics.setWatchCi(topicId, enable);

    if (!enable) {
      this.stopWatch(topicId);
      return;
    }

    // If already watching, don't double-register.
    if (this.ciPollers.has(topicId)) return;

    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error(`topic ${topicId} not found`);
    if (!topic.prNumber) return; // no PR yet; skip — watch will be re-armed when PR is available

    const repo = this.deps.repos.getById(topic.repoId)!;
    const startedAt = Date.now();
    const HARD_DEADLINE_MS = 60 * 60 * 1000; // stop after 1h regardless of state

    let prevState: CiRollupState | null = null;

    // Self-scheduling poll loop. Cadence: 20s for the first minute (fresh PR
    // window where GitHub is still spinning up workflows), then 60s. Stop
    // early when every check is completed — no further state to observe —
    // or when the 1h hard deadline fires.
    const pickDelay = (): number => (Date.now() - startedAt < 60_000 ? 20_000 : 60_000);

    const tick = async () => {
      await this._pollCi(topicId, repo.path, topic.prNumber!, repo.defaultBranch, prevState, (curr) => {
        prevState = curr;
      });
      this.deps.onTopicChanged?.(topicId);
      // Decide whether to stop: use the fresh cache bundle as the ground truth.
      try {
        const bundle = await this.deps.prCache.get(repo.path, topic.prNumber!, repo.defaultBranch);
        const allDone = bundle.checks.length > 0 && bundle.checks.every((c) => c.status === 'completed');
        if (allDone) { this.stopWatch(topicId); return; }
      } catch { /* transient — schedule next tick anyway */ }
      if (Date.now() - startedAt >= HARD_DEADLINE_MS) { this.stopWatch(topicId); return; }
      const handle = (this._setTimeout ?? setTimeout)(() => {
        tick().catch((e) => console.error(`[ci-watch] poll error for ${topicId}:`, e));
      }, pickDelay());
      this.ciPollers.set(topicId, handle);
    };

    // Prime with an immediate poll; tick() itself schedules the next one.
    await tick();
  }

  /**
   * Stop a CI poll watcher for a topic without persisting (use watchCi(id, false)
   * for the full disable path). Called by Plan 4 PR-merge handler and tests.
   */
  stopWatch(topicId: string): void {
    const handle = this.ciPollers.get(topicId);
    if (handle !== undefined) {
      // Handle may be from either setInterval (legacy) or setTimeout (new cadence);
      // both return the same node Timeout object so either clear function works.
      this._clearTimeout(handle as ReturnType<typeof setTimeout>);
      this.ciPollers.delete(topicId);
    }
  }

  /**
   * Perform one CI poll cycle. Exported for direct test use.
   * Returns the new rollup state.
   */
  async _pollCi(
    topicId: string,
    repoCwd: string,
    prNumber: number,
    defaultBranch: string,
    prevState: CiRollupState | null,
    onState: (curr: CiRollupState) => void,
  ): Promise<CiRollupState> {
    const bundle = await this.deps.prCache.get(repoCwd, prNumber, defaultBranch, true);
    const topic = this.deps.topics.getById(topicId);
    const nonVoting = topic ? this.deps.repos.listNonVoting(topic.repoId) : [];
    const curr = ciRollup(bundle, nonVoting);

    // Record every completed check into the history store so the flaky
    // classifier has data to work with. In-flight checks are skipped —
    // we only want definitive outcomes.
    if (topic && this.deps.ciHistory) {
      for (const c of bundle.checks) {
        if (c.status === 'completed' && c.conclusion) {
          this.deps.ciHistory.record(topic.repoId, c.name, prNumber, c.runId ?? null, c.conclusion);
        }
      }
    }

    const shouldNotify =
      prevState !== null &&
      prevState !== curr &&
      this.deps.notifications;

    if (shouldNotify && topic) {
      this.deps.notifications!.ciStateChanged(topic, prevState!, curr);
    }

    onState(curr);
    return curr;
  }

  async addressFeedback(
    topicId: string,
    opts: { includeCi: boolean; includeComments: boolean }
  ): Promise<{ sessionId: string }> {
    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    const bundle = await this.deps.prCache.get(repo.path, topic.prNumber!, repo.defaultBranch);

    const threads = opts.includeComments
      ? bundle.threads.filter((t) => !t.isResolved && t.comments.some((c) => !c.isBot))
      : [];

    const failingRequired = opts.includeCi
      ? bundle.checks.filter(
          (c) => c.conclusion === 'failure' && bundle.requiredContexts.includes(c.name)
        )
      : [];

    if (threads.length === 0 && failingRequired.length === 0) {
      throw new Error('nothing to address');
    }

    const prompt = renderActionPrompt({
      action: threads.length ? 'pr-fix' : 'ci-watch',
      skills: repo.skills,
      fixCtx: {
        threads: threads.flatMap((t) =>
          t.comments
            .filter((c) => !c.isBot)
            .map((c) => ({ id: t.id, path: c.path, line: c.line, body: c.body }))
        ),
        checks: await Promise.all(
          failingRequired.map(async (c) => ({
            name: c.name,
            logTail: await fetchFailedLog(repo.path, c.runId).catch(() => ''),
          }))
        ),
      },
    });

    const result = await this.deps.topicManager.addFixTask(topicId, {
      type: threads.length ? 'fix-comments' : 'fix-ci',
      prompt,
      effort: 'high',
      permissionMode: 'acceptEdits',
      parentTrigger: {
        threadIds: threads.map((t) => t.id),
        checkNames: failingRequired.map((c) => c.name),
      },
    });

    return { sessionId: result.sessionId };
  }

  async fixComment(topicId: string, threadId: string): Promise<{ sessionId: string }> {
    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    const bundle = await this.deps.prCache.get(repo.path, topic.prNumber!, repo.defaultBranch);

    const thread = bundle.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`thread ${threadId} not found`);

    const prompt = renderActionPrompt({
      action: 'pr-fix',
      skills: repo.skills,
      fixCtx: {
        threads: thread.comments
          .filter((c) => !c.isBot)
          .map((c) => ({ id: thread.id, path: c.path, line: c.line, body: c.body })),
      },
    });

    const result = await this.deps.topicManager.addFixTask(topicId, {
      type: 'fix-comments',
      prompt,
      effort: 'high',
      permissionMode: 'acceptEdits',
      parentTrigger: { threadIds: [threadId] },
    });

    return { sessionId: result.sessionId };
  }

  async onFixAccepted(topic: Topic, task: Task, commitSha: string): Promise<void> {
    const repo = this.deps.repos.getById(topic.repoId)!;

    if (topic.prNumber != null) {
      this.deps.prCache.invalidate(repo.path, topic.prNumber);
    }

    const trigger = task.parentTrigger as { threadIds?: string[] } | null;
    const threadIds = trigger?.threadIds ?? [];

    for (const threadId of threadIds) {
      try {
        await this.deps.adapter(repo.id).replyOnThread(repo.path, threadId, `Fixed in ${commitSha}`);
      } catch (e) {
        console.error(`[pr-lifecycle] replyOnThread(${threadId}) failed:`, e);
      }
      try {
        await this.deps.adapter(repo.id).resolveThread(repo.path, threadId);
      } catch (e) {
        console.error(`[pr-lifecycle] resolveThread(${threadId}) failed:`, e);
      }
    }
  }

  async fixCheck(topicId: string, checkName: string): Promise<{ sessionId: string }> {
    const topic = this.deps.topics.getById(topicId);
    if (!topic) throw new Error('topic not found');
    const repo = this.deps.repos.getById(topic.repoId)!;
    const bundle = await this.deps.prCache.get(repo.path, topic.prNumber!, repo.defaultBranch);

    const check = bundle.checks.find((c) => c.name === checkName);
    if (!check) throw new Error(`check ${checkName} not found`);

    const logTail = await fetchFailedLog(repo.path, check.runId).catch((e) => {
      console.warn(`[fixCheck] could not fetch log for run ${check.runId}:`, (e as Error).message);
      return '';
    });

    const prompt = renderActionPrompt({
      action: 'ci-watch',
      skills: repo.skills,
      fixCtx: {
        checks: [{ name: check.name, logTail }],
      },
    });

    const result = await this.deps.topicManager.addFixTask(topicId, {
      type: 'fix-ci',
      prompt,
      effort: 'high',
      permissionMode: 'acceptEdits',
      parentTrigger: { checkNames: [checkName] },
    });

    return { sessionId: result.sessionId };
  }
}

function defaultBody(topic: Pick<Topic, 'title' | 'ticketKey'>): string {
  return `## Summary\n\n_TODO_\n\n## Test plan\n\n- [ ] _TODO_\n${topic.ticketKey ? `\nTicket: ${topic.ticketKey}\n` : ''}`;
}
