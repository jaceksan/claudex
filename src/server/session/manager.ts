import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SessionProcess, type SessionProcessOptions } from './process.js';
import { initialState, reduce, type SessionState } from './state.js';
import type { StreamEvent } from '../stream-json/types.js';
import type { SessionRow } from '../db.js';

export interface SessionHandle extends EventEmitter {
  id: string;
  state: SessionState;
  readonly eventLog: StreamEvent[]; // ring buffer
  process: SessionProcess | null;
  send(text: string): void;
  kill(): void;
}

export interface CreateSessionOpts {
  cwd: string;
  prompt?: string;
  permissionMode?: string;
  label?: string;
  resumeSessionId?: string;
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
      resumeSessionId: opts.resumeSessionId,
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

    let registered = false;
    proc.on('event', (ev) => {
      handle.state = reduce(handle.state, ev);
      ring.push(ev);
      if (ring.length > ringSize) ring.shift();
      // Claude emits several system subtypes (init, hook_started, hook_response, etc.)
      // Register on the first event that carries a session_id so we work across versions/hooks.
      const sid = (ev as { session_id?: string }).session_id;
      if (sid && !registered) {
        if (sid !== handle.id) handle.id = sid;
        handle.state = {
          ...handle.state,
          sessionId: sid,
          status: handle.state.status === 'starting' ? 'running' : handle.state.status,
        };
        this.sessions.set(handle.id, handle);
        registered = true;
        this.emit('created', handle);
      }
      handle.emit('event', ev);
      this.emit('event', handle, ev);
    });
    proc.on('parseError', () => {
      handle.state = { ...handle.state, parseErrors: handle.state.parseErrors + 1 };
      handle.emit('stateChange', handle.state);
    });
    const ensureRegistered = () => {
      if (!registered) {
        this.sessions.set(handle.id, handle);
        registered = true;
        this.emit('created', handle);
      }
    };
    proc.on('exit', (code) => {
      if (handle.state.status !== 'ended' && handle.state.status !== 'crashed') {
        handle.state = {
          ...handle.state,
          status: code === 0 ? 'ended' : 'crashed',
          error: code === 0 ? null : proc.getStderrTail(),
        };
      }
      ensureRegistered();
      handle.emit('ended', handle.state);
      this.emit('ended', handle);
    });
    proc.on('error', (err) => {
      handle.state = { ...handle.state, status: 'crashed', error: err.message };
      ensureRegistered();
      handle.emit('ended', handle.state);
      this.emit('ended', handle);
    });

    proc.start();
    return handle;
  }

  kill(id: string): void {
    this.sessions.get(id)?.kill();
  }

  delete(id: string): void {
    const h = this.sessions.get(id);
    if (!h) return;
    try { h.kill(); } catch { /* ignore */ }
    this.sessions.delete(id);
    this.emit('deleted', id);
  }

  registerDetached(row: SessionRow): SessionHandle {
    const handle = Object.assign(new EventEmitter(), {
      id: row.id,
      state: {
        ...initialState(row.id, row.cwd),
        status: 'detached' as const,
        error: row.error,
        lastActivityAt: row.last_event_at,
      },
      eventLog: [] as StreamEvent[],
      process: null as SessionProcess | null,
      send() { throw new Error('session is detached'); },
      kill() { /* no-op */ },
    }) as SessionHandle;
    this.sessions.set(row.id, handle);
    return handle;
  }

  resume(opts: { cwd: string; resumeSessionId: string; backlog?: StreamEvent[] }): SessionHandle {
    // Remove any existing detached handle under this id before re-creating
    this.sessions.delete(opts.resumeSessionId);
    const handle = this.create({ cwd: opts.cwd, resumeSessionId: opts.resumeSessionId });
    // Replay backlog through reducer before live events arrive
    if (opts.backlog) {
      for (const ev of opts.backlog) {
        handle.state = reduce(handle.state, ev);
        handle.eventLog.push(ev);
      }
    }
    return handle;
  }
}
