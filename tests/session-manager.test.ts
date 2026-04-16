import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/server/session/manager';
import { once } from 'node:events';

const FAKE_CMD = 'node';
const FAKE_ARGS = [
  '-e',
  `process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'mgr-1',cwd:process.cwd()}) + '\\n');
   setTimeout(() => {
     process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'mgr-1',is_error:false,total_cost_usd:0}) + '\\n');
     process.exit(0);
   }, 50);`,
];

describe('SessionManager', () => {
  it('creates a session, tracks state, and cleans up on exit', async () => {
    const mgr = new SessionManager({ spawnOverride: () => ({ command: FAKE_CMD, args: FAKE_ARGS }) });
    const s = mgr.create({ cwd: process.cwd() });
    expect(s.state.status).toBe('starting');
    await once(s, 'ended');
    expect(s.state.status).toBe('ended');
    expect(s.state.claudeSessionId).toBe('mgr-1'); // claude's id recorded
    expect(s.state.sessionId).not.toBe('mgr-1');    // UI id stays stable
    expect(mgr.list()).toHaveLength(1);             // kept after exit
  });
});
