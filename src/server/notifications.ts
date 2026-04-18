import { EventEmitter } from 'node:events';
import type { StreamEvent } from './stream-json/types.js';

export type CiRollupState = 'running' | 'ok' | 'failed';

export type NotificationKind = 'session-ended' | 'tool-error' | 'plan-ready' | 'permission-pending' | 'ci-state-changed';

export interface Notification {
  sessionId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  timestamp: number;
}

export interface NotificationContext { sessionId: string; title: string | null }

function label(ctx: NotificationContext): string {
  return ctx.title?.trim() || ctx.sessionId.slice(0, 8);
}

export interface CiNotification {
  topicId: string;
  topicTitle: string;
  kind: 'ci-state-changed';
  prev: CiRollupState;
  curr: CiRollupState;
  title: string;
  body: string;
  timestamp: number;
}

export class NotificationEngine extends EventEmitter {
  /**
   * Emit an OS-only notification when CI state transitions on a watched topic.
   * Fires the 'ci-notification' event (not 'notification') so it bypasses the
   * in-app toaster (which was removed in Plan 2) and is picked up only by OS
   * notification backends.
   */
  ciStateChanged(topic: { id: string; title: string }, prev: CiRollupState, curr: CiRollupState): void {
    const stateLabel: Record<CiRollupState, string> = { running: 'Running', ok: 'Passed', failed: 'Failed' };
    const n: CiNotification = {
      topicId: topic.id,
      topicTitle: topic.title,
      kind: 'ci-state-changed',
      prev,
      curr,
      title: `CI ${stateLabel[curr]} · ${topic.title}`,
      body: `Status changed: ${stateLabel[prev]} → ${stateLabel[curr]}`,
      timestamp: Date.now(),
    };
    this.emit('ci-notification', n);
  }

  handle(ctx: NotificationContext, event: StreamEvent): void {
    const ts = Date.now();
    const sessionId = ctx.sessionId;
    const name = label(ctx);
    if (event.type === 'result') {
      this.emit('notification', {
        sessionId, timestamp: ts, kind: 'session-ended',
        title: event.is_error ? 'Session crashed' : 'Session finished',
        body: `${name} · ${event.subtype}`,
      } satisfies Notification);
      return;
    }

    // Tool errors (Path does not exist, Exit code 2, etc.) are almost always
    // speculative-call failures that Claude self-corrects on the next turn. Firing
    // an OS notification for every one of those is pure noise, and the muted
    // collapsible in the event feed is the right place for them. Session crashes
    // still fire via the 'result' branch above with title "Session crashed".

    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
          this.emit('notification', {
            sessionId, timestamp: ts, kind: 'plan-ready',
            title: 'Plan ready for review', body: name,
          } satisfies Notification);
          return;
        }
      }
    }
  }
}
