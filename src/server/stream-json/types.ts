// Mirrors Claude Code CLI stream-json output. Kept minimal; extend as needed.

export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd: string;
  model?: string;
  tools?: string[];
}

export interface AssistantEvent {
  type: 'assistant';
  message: {
    id: string;
    role: 'assistant';
    content: ContentBlock[];
    stop_reason?: string | null;
    usage?: Usage;
  };
  session_id: string;
}

export interface UserEvent {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  session_id?: string;
}

export interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  session_id: string;
  is_error: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
}

export type StreamEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent;

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
