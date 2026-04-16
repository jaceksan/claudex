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
  const base = { ...state, lastActivityAt: Date.now() };
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        return { ...base, status: 'running', sessionId: event.session_id, cwd: event.cwd };
      }
      return base;

    case 'assistant': {
      let lastText = base.lastAssistantText;
      let currentTool = base.currentTool;
      let planText = base.planText;
      for (const block of event.message.content) {
        if (block.type === 'text') {
          lastText = block.text;
        } else if (block.type === 'tool_use') {
          currentTool = {
            id: block.id,
            name: block.name,
            input: block.input,
            startedAt: Date.now(),
          };
          if (block.name === 'ExitPlanMode') {
            planText = (block.input.plan as string) ?? '';
          }
        }
      }
      const usage = event.message.usage;
      const tokens = usage
        ? { input: base.tokens.input + usage.input_tokens, output: base.tokens.output + usage.output_tokens }
        : base.tokens;
      return { ...base, lastAssistantText: lastText, currentTool, planText, tokens };
    }

    case 'user': {
      let currentTool = base.currentTool;
      let completedTools = base.completedTools;
      let error = base.error;
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          if (currentTool && currentTool.id === block.tool_use_id) {
            currentTool = null;
            completedTools += 1;
          }
          if (block.is_error) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            error = text;
          }
        }
      }
      return { ...base, currentTool, completedTools, error };
    }

    case 'result': {
      return {
        ...base,
        status: event.is_error ? 'crashed' : 'ended',
        costUsd: event.total_cost_usd ?? base.costUsd,
      };
    }

    default:
      return base;
  }
}
