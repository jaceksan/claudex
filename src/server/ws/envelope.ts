import type { StreamEvent } from '../stream-json/types.js';
import type { SessionState } from '../session/state.js';
import type { Notification } from '../notifications.js';

export type ServerEnvelope =
  | { type: 'session.created'; payload: { state: SessionState } }
  | { type: 'session.updated'; payload: { state: SessionState } }
  | { type: 'session.event';   payload: { sessionId: string; event: StreamEvent } }
  | { type: 'session.ended';   payload: { state: SessionState } }
  | { type: 'session.list';    payload: { sessions: SessionState[] } }
  | { type: 'session.replay';  payload: { state: SessionState; events: StreamEvent[] } }
  | { type: 'notification';    payload: Notification }
  | { type: 'error';           payload: { message: string; requestId?: string } };

export type ClientEnvelope =
  | { type: 'client.subscribe';   payload: { sessionId: string }; requestId?: string }
  | { type: 'client.unsubscribe'; payload: { sessionId: string }; requestId?: string }
  | { type: 'client.launch';      payload: { cwd: string; prompt?: string; permissionMode?: string; label?: string }; requestId?: string }
  | { type: 'client.sendInput';   payload: { sessionId: string; text: string }; requestId?: string }
  | { type: 'client.kill';        payload: { sessionId: string }; requestId?: string }
  | { type: 'client.listSessions'; payload: {}; requestId?: string };
