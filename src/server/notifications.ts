import { EventEmitter } from 'node:events';
import type { StreamEvent } from './stream-json/types.js';

export type NotificationKind = 'session-ended' | 'tool-error' | 'plan-ready' | 'permission-pending';

export interface Notification {
  sessionId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  timestamp: number;
}

export class NotificationEngine extends EventEmitter {
  handle(sessionId: string, event: StreamEvent): void {
    const ts = Date.now();
    if (event.type === 'result') {
      this.emit('notification', {
        sessionId, timestamp: ts, kind: 'session-ended',
        title: event.is_error ? 'Session crashed' : 'Session finished',
        body: `${sessionId.slice(0, 8)} · ${event.subtype}`,
      } satisfies Notification);
      return;
    }

    if (event.type === 'user') {
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (typeof block === 'object' && block.type === 'tool_result' && block.is_error) {
          this.emit('notification', {
            sessionId, timestamp: ts, kind: 'tool-error',
            title: 'Tool error', body: String(block.content).slice(0, 200),
          } satisfies Notification);
          return;
        }
      }
    }

    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
          this.emit('notification', {
            sessionId, timestamp: ts, kind: 'plan-ready',
            title: 'Plan ready for review', body: sessionId.slice(0, 8),
          } satisfies Notification);
          return;
        }
      }
    }
  }
}
