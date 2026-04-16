import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscriptReader } from '../src/server/session/transcript';

describe('TranscriptReader', () => {
  it('finds and parses a transcript by session id', () => {
    const root = mkdtempSync(join(tmpdir(), 'claudex-tr-'));
    const hashDir = join(root, 'someHash');
    mkdirSync(hashDir);
    const sid = 'test-session-123';
    writeFileSync(join(hashDir, `${sid}.jsonl`),
      '{"type":"system","subtype":"init","session_id":"test-session-123","cwd":"/tmp"}\n' +
      '{"type":"result","subtype":"success","session_id":"test-session-123","is_error":false}\n'
    );
    const tr = new TranscriptReader(root);
    const events = tr.readEvents(sid);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('system');
    rmSync(root, { recursive: true });
  });

  it('returns empty array for missing transcript', () => {
    const root = mkdtempSync(join(tmpdir(), 'claudex-tr-'));
    const tr = new TranscriptReader(root);
    expect(tr.readEvents('nope')).toEqual([]);
    rmSync(root, { recursive: true });
  });
});
