import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, reduce, type SessionState } from '../src/server/session/state';
import { parseBuffer } from '../src/server/stream-json/parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('SessionState', () => {
  it('has a sensible initial state', () => {
    const s = initialState('sess-1', '/tmp');
    expect(s).toMatchObject({
      sessionId: 'sess-1',
      cwd: '/tmp',
      status: 'starting',
      lastAssistantText: '',
      currentTool: null,
      parseErrors: 0,
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    });
    expect(s.lastActivityAt).toBeTypeOf('number');
  });
});

describe('reduce', () => {
  it('system:init transitions starting→running and records claudeSessionId (UI sessionId is stable)', () => {
    const s0 = initialState('pending', '/tmp');
    const s1 = reduce(s0, {
      type: 'system',
      subtype: 'init',
      session_id: 'real-id',
      cwd: '/tmp',
    });
    expect(s1.status).toBe('running');
    expect(s1.claudeSessionId).toBe('real-id');
    expect(s1.sessionId).toBe('pending'); // UI id doesn't change
  });

  it('assistant text event updates lastAssistantText', () => {
    const s0 = { ...initialState('s', '/tmp'), status: 'running' as const };
    const s1 = reduce(s0, {
      type: 'assistant',
      session_id: 's',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });
    expect(s1.lastAssistantText).toBe('Hello world');
  });
});

describe('reduce: tool_result and result', () => {
  it('user tool_result clears currentTool and increments completedTools', () => {
    const s0: SessionState = {
      ...initialState('s', '/tmp'),
      status: 'running',
      currentTool: { id: 't1', name: 'Bash', input: {}, startedAt: 0 },
    };
    const s1 = reduce(s0, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    });
    expect(s1.currentTool).toBeNull();
    expect(s1.completedTools).toBe(1);
  });

  it('successful tool_result clears a prior error', () => {
    const s0: SessionState = {
      ...initialState('s', '/tmp'),
      status: 'running',
      error: 'previous boom',
      currentTool: { id: 't2', name: 'Bash', input: {}, startedAt: 0 },
    };
    const s1 = reduce(s0, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }],
      },
    });
    expect(s1.error).toBeNull();
  });

  it('tool_result with is_error records error status', () => {
    const s0: SessionState = {
      ...initialState('s', '/tmp'),
      status: 'running',
      currentTool: { id: 't1', name: 'Bash', input: {}, startedAt: 0 },
    };
    const s1 = reduce(s0, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
      },
    });
    expect(s1.error).toMatch(/boom/);
  });

  it('result event transitions to idle (turn complete, subprocess still alive) and sets cost', () => {
    const s0: SessionState = { ...initialState('s', '/tmp'), status: 'running' };
    const s1 = reduce(s0, {
      type: 'result',
      subtype: 'success',
      session_id: 's',
      is_error: false,
      duration_ms: 1000,
      total_cost_usd: 0.02,
    });
    expect(s1.status).toBe('idle');
    expect(s1.costUsd).toBe(0.02);
  });
});

describe('reduce: fixture replay', () => {
  it('simple-chat lands on status=idle and non-empty lastAssistantText after final result', () => {
    const content = readFileSync(join(__dirname, 'fixtures/simple-chat.jsonl'), 'utf8');
    const { events } = parseBuffer(content);
    let s = initialState('pending', '/tmp');
    for (const ev of events) s = reduce(s, ev);
    expect(s.status).toBe('idle');
    expect(s.lastAssistantText.length).toBeGreaterThan(0);
  });

  it('plan-mode produces a non-null planText', () => {
    const content = readFileSync(join(__dirname, 'fixtures/plan-mode.jsonl'), 'utf8');
    const { events } = parseBuffer(content);
    let s = initialState('pending', '/tmp');
    for (const ev of events) s = reduce(s, ev);
    expect(s.planText).not.toBeNull();
  });

  it('error-result fixture records the error and ends at idle (subprocess exit decides ended/crashed)', () => {
    const content = readFileSync(join(__dirname, 'fixtures/error-result.jsonl'), 'utf8');
    const { events } = parseBuffer(content);
    let s = initialState('pending', '/tmp');
    for (const ev of events) s = reduce(s, ev);
    expect(s.status).toBe('idle');
    expect(s.error).toMatch(/exit code 1/);
  });
});
