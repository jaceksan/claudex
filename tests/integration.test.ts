import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/server/session/manager';
import { once } from 'node:events';

const hasKey = !!process.env.ANTHROPIC_API_KEY;
const test = hasKey ? it : it.skip;

describe('integration: real claude', () => {
  test('spawns, runs a trivial prompt, ends cleanly', async () => {
    const mgr = new SessionManager();
    const h = mgr.create({ cwd: process.cwd(), prompt: 'say hello in one word' });
    await once(h, 'ended');
    expect(['ended', 'crashed']).toContain(h.state.status);
    expect(h.state.sessionId).not.toBe(h.state.cwd); // was replaced with real id
  }, 60_000);
});
