import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, parseBuffer } from '../src/server/stream-json/parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseLine', () => {
  it('parses a system init event', () => {
    const line = '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp"}';
    const ev = parseLine(line);
    expect(ev).toMatchObject({ type: 'system', subtype: 'init', session_id: 's1' });
  });

  it('returns null for blank lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  it('throws ParseError on malformed JSON', () => {
    expect(() => parseLine('{not json')).toThrow(/parse/i);
  });
});

describe('parseBuffer', () => {
  it('splits a multi-line buffer into events, returning remainder', () => {
    const buf = '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp"}\n{"type":"partial';
    const { events, remainder } = parseBuffer(buf);
    expect(events).toHaveLength(1);
    expect(remainder).toBe('{"type":"partial');
  });
});

describe('parseBuffer on fixtures', () => {
  it('parses simple-chat.jsonl fully', () => {
    const content = readFileSync(join(__dirname, 'fixtures/simple-chat.jsonl'), 'utf8');
    const { events, remainder, errors } = parseBuffer(content);
    expect(errors).toHaveLength(0);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('system');
    expect(events.at(-1)?.type).toBe('result');
    expect(remainder).toBe('');
  });
});
