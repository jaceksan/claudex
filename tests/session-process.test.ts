import { describe, it, expect } from 'vitest';
import { SessionProcess } from '../src/server/session/process';
import { once } from 'node:events';

// Fake "claude" that echoes two JSONL events then exits.
const FAKE_CMD = 'node';
const FAKE_ARGS = [
  '-e',
  `
  process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'fake-1',cwd:process.cwd()}) + '\\n');
  setTimeout(() => {
    process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'fake-1',is_error:false,total_cost_usd:0}) + '\\n');
    process.exit(0);
  }, 50);
  `,
];

describe('SessionProcess', () => {
  it('emits events and exits', async () => {
    const proc = new SessionProcess({
      cwd: process.cwd(),
      command: FAKE_CMD,
      args: FAKE_ARGS,
    });
    const events: unknown[] = [];
    proc.on('event', (ev) => events.push(ev));
    proc.start();
    await once(proc, 'exit');
    expect(events.map((e: any) => e.type)).toEqual(['system', 'result']);
  });

  it('sendUserMessage writes a stream-json line to stdin', async () => {
    const sink = 'node';
    const args = [
      '-e',
      `let d=''; process.stdin.on('data', c => d += c);
       process.stdin.on('end', () => { process.stdout.write(d); process.exit(0); });`,
    ];
    const proc = new SessionProcess({ cwd: process.cwd(), command: sink, args });
    let captured = '';
    proc.on('stdoutRaw', (chunk) => (captured += chunk));
    proc.start();
    proc.sendUserMessage('hello');
    proc.closeStdin();
    await once(proc, 'exit');
    const parsed = JSON.parse(captured.trim());
    expect(parsed).toMatchObject({ type: 'user', message: { role: 'user' } });
  });
});
