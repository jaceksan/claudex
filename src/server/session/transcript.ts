import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseBuffer } from '../stream-json/parser.js';
import type { StreamEvent } from '../stream-json/types.js';

// Claude Code stores transcripts at ~/.claude/projects/<hash>/<session-id>.jsonl
// The hash algorithm isn't stable, so we search by filename.
export class TranscriptReader {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? join(homedir(), '.claude', 'projects');
  }

  findTranscript(sessionId: string): string | null {
    if (!existsSync(this.root)) return null;
    const file = `${sessionId}.jsonl`;
    for (const dir of readdirSync(this.root)) {
      const candidate = join(this.root, dir, file);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  readEvents(sessionId: string): StreamEvent[] {
    const path = this.findTranscript(sessionId);
    if (!path) return [];
    const content = readFileSync(path, 'utf8');
    return parseBuffer(content).events;
  }
}
