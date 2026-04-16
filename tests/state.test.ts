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
  it('system:init transitions to running and adopts session_id', () => {
    const s0 = initialState('pending', '/tmp');
    const s1 = reduce(s0, {
      type: 'system',
      subtype: 'init',
      session_id: 'real-id',
      cwd: '/tmp',
    });
    expect(s1.status).toBe('running');
    expect(s1.sessionId).toBe('real-id');
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
