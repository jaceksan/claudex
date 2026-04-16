import type { StreamEvent } from './types.js';

export class ParseError extends Error {}

export function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch (e) {
    throw new ParseError(`Failed to parse stream-json line: ${(e as Error).message}`);
  }
}

export interface BufferParseResult {
  events: StreamEvent[];
  remainder: string;
  errors: ParseError[];
}

export function parseBuffer(buf: string): BufferParseResult {
  const lines = buf.split('\n');
  const remainder = lines.pop() ?? '';
  const events: StreamEvent[] = [];
  const errors: ParseError[] = [];
  for (const line of lines) {
    try {
      const ev = parseLine(line);
      if (ev) events.push(ev);
    } catch (e) {
      if (e instanceof ParseError) errors.push(e);
      else throw e;
    }
  }
  return { events, remainder, errors };
}
