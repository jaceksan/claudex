import type { StreamEvent } from '../stream-json/types.js';

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'waiting-permission'
  | 'idle'
  | 'ended'
  | 'crashed'
  | 'detached';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  lastAssistantText: string;
  currentTool: ToolCall | null;
  completedTools: number;
  parseErrors: number;
  tokens: { input: number; output: number };
  costUsd: number;
  lastActivityAt: number;
  planText: string | null;
  error: string | null;
}

export function initialState(sessionId: string, cwd: string): SessionState {
  return {
    sessionId,
    cwd,
    status: 'starting',
    lastAssistantText: '',
    currentTool: null,
    completedTools: 0,
    parseErrors: 0,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    lastActivityAt: Date.now(),
    planText: null,
    error: null,
  };
}

export function reduce(state: SessionState, event: StreamEvent): SessionState {
  return { ...state, lastActivityAt: Date.now() };
}
