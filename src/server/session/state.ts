import type { StreamEvent } from '../stream-json/types.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const DEFAULT_EFFORT: EffortLevel = 'medium';

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

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
  sessionId: string;         // Stable UI id (our UUID placeholder, or Claude's session_id when resuming from disk).
  claudeSessionId: string | null; // Claude's internal session_id — used for `claude --resume`.
  cwd: string;
  title: string | null;      // User-supplied label; falls back to cwd basename in the UI.
  status: SessionStatus;
  lastAssistantText: string;
  currentTool: ToolCall | null;
  completedTools: number;
  parseErrors: number;
  tokens: { input: number; output: number };
  costUsd: number;
  // Baselines carried forward across resumes (loaded from SQLite on rehydration).
  // Display totals = baseline* + subprocess-scope counters above.
  baselineCostUsd: number;
  baselineTokens: { input: number; output: number };
  turns: number; // cumulative turn count across resumes (incremented on `result`)
  lastActivityAt: number;
  planText: string | null;
  error: string | null;
  effort: EffortLevel;
}

export function initialState(sessionId: string, cwd: string): SessionState {
  return {
    sessionId,
    claudeSessionId: null,
    cwd,
    title: null,
    status: 'starting',
    lastAssistantText: '',
    currentTool: null,
    completedTools: 0,
    parseErrors: 0,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    baselineCostUsd: 0,
    baselineTokens: { input: 0, output: 0 },
    turns: 0,
    lastActivityAt: Date.now(),
    planText: null,
    error: null,
    effort: DEFAULT_EFFORT,
  };
}

export function reduce(state: SessionState, event: StreamEvent): SessionState {
  const base = { ...state, lastActivityAt: Date.now() };
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        return {
          ...base,
          status: base.status === 'starting' ? 'running' : base.status,
          claudeSessionId: event.session_id,
          cwd: event.cwd,
        };
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
      // A result event means the current turn finished — in multi-turn stream-json mode
      // the subprocess stays alive waiting for the next user message. True end/crash is
      // only known when the subprocess exits (handled in SessionManager).
      return {
        ...base,
        status: 'idle',
        costUsd: event.total_cost_usd ?? base.costUsd,
        turns: base.turns + 1,
      };
    }

    default:
      return base;
  }
}
