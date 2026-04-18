/**
 * quick-fix-auto.ts
 *
 * Automatic accept + PR creation for quick-fix topic attempts.
 *
 * When a session ends successfully (status === 'ended'), look up the task for
 * that session.  If it is an un-accepted `attempt` task on a `quick-fix` topic,
 * call acceptAttempt then createPR — best-effort (errors are logged, not thrown).
 *
 * The handler is a plain function so it can be unit-tested in isolation without
 * touching SessionManager or spawning real processes.
 */

import type { TaskStore } from './task.js';
import type { TopicStore } from './topic.js';

export interface QuickFixAutoDeps {
  tasks: TaskStore;
  topics: TopicStore;
  acceptAttempt: (sessionId: string) => Promise<void>;
  createPR: (topicId: string, args: { title?: string; body?: string }) => Promise<unknown>;
}

/**
 * Called by the SessionManager 'ended' event listener.
 * `finalStatus` must be 'ended' (success) — callers should skip 'crashed'.
 */
export async function onSessionEnded(
  sessionId: string,
  finalStatus: string,
  deps: QuickFixAutoDeps,
): Promise<void> {
  if (finalStatus !== 'ended') return;

  const task = deps.tasks.getBySession(sessionId);
  if (!task) return;
  if (task.type !== 'attempt') return;
  if (task.acceptedAt != null) return; // already accepted

  const topic = deps.topics.getById(task.topicId);
  if (!topic) return;
  if (topic.template !== 'quick-fix') return;

  try {
    await deps.acceptAttempt(sessionId);
  } catch (e) {
    console.error('[quick-fix-auto] acceptAttempt failed', e);
    return;
  }

  try {
    await deps.createPR(task.topicId, {} as { title?: string; body?: string });
  } catch (e) {
    console.error('[quick-fix-auto] createPR failed', e);
  }
}
