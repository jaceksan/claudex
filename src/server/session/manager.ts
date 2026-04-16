import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SessionProcess, type SessionProcessOptions } from './process.js';
import { initialState, reduce, type SessionState } from './state.js';
import type { StreamEvent } from '../stream-json/types.js';

export interface SessionHandle extends EventEmitter {
  id: string;
  state: SessionState;
  readonly eventLog: StreamEvent[]; // ring buffer
  process: SessionProcess;
  send(text: string): void;
  kill(): void;
}

export interface CreateSessionOpts {
  cwd: string;
  prompt?: string;
  permissionMode?: string;
  label?: string;
}

type SpawnOverride = (opts: CreateSessionOpts) => { command?: string; args?: string[] };

export interface SessionManagerOpts {
  spawnOverride?: SpawnOverride;
  ringSize?: number;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionHandle>();
  constructor(private readonly opts: SessionManagerOpts = {}) { super(); }

  list(): SessionHandle[] {
    return [...this.sessions.values()];
  }

  get(id: string): SessionHandle | undefined {
    return this.sessions.get(id);
  }

  create(opts: CreateSessionOpts): SessionHandle {
    const localId = randomUUID(); // placeholder until system:init provides real id
    const ring: StreamEvent[] = [];
    const ringSize = this.opts.ringSize ?? 500;
    const processOpts: SessionProcessOptions = {
      cwd: opts.cwd,
      prompt: opts.prompt,
      permissionMode: opts.permissionMode,
      ...this.opts.spawnOverride?.(opts),
    };
    const proc = new SessionProcess(processOpts);
    const handle = Object.assign(new EventEmitter(), {
      id: localId,
      state: initialState(localId, opts.cwd),
      eventLog: ring,
      process: proc,
      send(text: string) { proc.sendUserMessage(text); },
      kill() { proc.kill(); },
    }) as SessionHandle;

    proc.on('event', (ev) => {
      handle.state = reduce(handle.state, ev);
      ring.push(ev);
      if (ring.length > ringSize) ring.shift();
      if (ev.type === 'system' && ev.subtype === 'init') {
        const realId = ev.session_id;
        if (realId !== handle.id) {
          this.sessions.delete(handle.id);
          handle.id = realId;
          this.sessions.set(realId, handle);
        }
      }
      handle.emit('event', ev);
      this.emit('event', handle, ev);
    });
    proc.on('parseError', () => {
      handle.state = { ...handle.state, parseErrors: handle.state.parseErrors + 1 };
      handle.emit('stateChange', handle.state);
    });
    proc.on('exit', (code) => {
      if (handle.state.status !== 'ended' && handle.state.status !== 'crashed') {
        handle.state = {
          ...handle.state,
          status: code === 0 ? 'ended' : 'crashed',
          error: code === 0 ? null : proc.getStderrTail(),
        };
      }
      handle.emit('ended', handle.state);
      this.emit('ended', handle);
    });
    proc.on('error', (err) => {
      handle.state = { ...handle.state, status: 'crashed', error: err.message };
      handle.emit('ended', handle.state);
    });

    this.sessions.set(localId, handle);
    proc.start();
    this.emit('created', handle);
    return handle;
  }

  kill(id: string): void {
    this.sessions.get(id)?.kill();
  }
}
