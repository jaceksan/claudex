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
