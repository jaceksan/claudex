import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseBuffer } from '../stream-json/parser.js';
import type { StreamEvent } from '../stream-json/types.js';
import type { EffortLevel } from './state.js';

export interface SessionProcessOptions {
  cwd: string;
  command?: string;            // override for tests; defaults to 'claude'
  args?: string[];             // override; defaults to stream-json flags
  permissionMode?: string;
  resumeSessionId?: string;
  effort?: EffortLevel;
  env?: NodeJS.ProcessEnv;
  appendSystemPrompt?: string; // forwarded as --append-system-prompt
}

type Events = {
  event: (ev: StreamEvent) => void;
  parseError: (message: string) => void;
  stderr: (chunk: string) => void;
  stdoutRaw: (chunk: string) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  error: (err: Error) => void;
};

export class SessionProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderrTail: string[] = [];
  private readonly maxStderrLines = 200;

  constructor(private readonly opts: SessionProcessOptions) {
    super();
  }

  start(): void {
    const command = this.opts.command ?? 'claude';
    const args = this.opts.args ?? this.buildDefaultArgs();
    this.child = spawn(command, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (chunk: string) => {
      this.emit('stdoutRaw', chunk);
      this.buffer += chunk;
      const { events, remainder, errors } = parseBuffer(this.buffer);
      this.buffer = remainder;
      for (const ev of events) this.emit('event', ev);
      for (const err of errors) this.emit('parseError', err.message);
    });

    this.child.stderr.on('data', (chunk: string) => {
      this.emit('stderr', chunk);
      for (const line of chunk.split('\n')) {
        if (line.length > 0) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > this.maxStderrLines) this.stderrTail.shift();
        }
      }
    });

    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code, signal) => this.emit('exit', code, signal));
  }

  sendUserMessage(text: string): void {
    if (!this.child) throw new Error('SessionProcess not started');
    const envelope = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    this.child.stdin.write(JSON.stringify(envelope) + '\n');
  }

  interrupt(): void {
    if (!this.child) return;
    const envelope = {
      type: 'control_request',
      request_id: `int-${Date.now()}`,
      request: { subtype: 'interrupt' },
    };
    this.child.stdin.write(JSON.stringify(envelope) + '\n');
  }

  closeStdin(): void {
    this.child?.stdin.end();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child?.kill(signal);
  }

  getStderrTail(): string {
    return this.stderrTail.join('\n');
  }

  private buildDefaultArgs(): string[] {
    // Canonical multi-turn headless invocation. The initial prompt is sent over stdin in start().
    // --include-partial-messages emits content_block_delta events for live streaming.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode);
    if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId);
    if (this.opts.effort) args.push('--effort', this.opts.effort);
    if (this.opts.appendSystemPrompt) args.push('--append-system-prompt', this.opts.appendSystemPrompt);
    return args;
  }
}

export interface SessionProcess {
  on<K extends keyof Events>(event: K, listener: Events[K]): this;
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean;
}
