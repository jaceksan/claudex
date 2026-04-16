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
  resumeSessionId?: string;     // Claude's internal session id — forwarded to `claude --resume`.
  presetUiId?: string;          // Keep this UI id for the new handle (used by Resume to reuse the detached card's id).
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
    // Prefer the caller-provided UI id (used by Resume to keep the detached card's id).
    // Otherwise, mint a new UUID — `resumeSessionId` (Claude's id) is never used as the UI id
    // because the two namespaces can diverge for fresh launches.
    const localId = opts.presetUiId ?? randomUUID();
    const ring: StreamEvent[] = [];
    const ringSize = this.opts.ringSize ?? 500;
    const processOpts: SessionProcessOptions = {
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      resumeSessionId: opts.resumeSessionId,
      ...this.opts.spawnOverride?.(opts),
    };
    const proc = new SessionProcess(processOpts);
    const ringSizeForHandle = ringSize;
    const self = this;
    const handle = Object.assign(new EventEmitter(), {
      id: localId,
      state: {
        ...initialState(localId, opts.cwd),
        claudeSessionId: opts.resumeSessionId ?? null,
      },
      eventLog: ring,
      process: proc,
      send(text: string) {
        // Echo locally first so the UI shows the message instantly, then forward to claude.
        const ev: StreamEvent = {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        };
        handle.state = reduce(handle.state, ev);
        ring.push(ev);
        if (ring.length > ringSizeForHandle) ring.shift();
        handle.emit('event', ev);
        self.emit('event', handle, ev);
        proc.sendUserMessage(text);
      },
      kill() { proc.kill(); },
    }) as SessionHandle;

    proc.on('event', (ev) => {
      handle.state = reduce(handle.state, ev);
      ring.push(ev);
      if (ring.length > ringSize) ring.shift();
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
      this.emit('ended', handle);
    });

    // Register + emit 'created' immediately so the UI shows a card the moment the user launches.
    this.sessions.set(handle.id, handle);
    this.emit('created', handle);
    proc.start();
    if (opts.prompt) handle.send(opts.prompt);
    return handle;
  }

  interrupt(id: string): void {
    this.sessions.get(id)?.process?.interrupt();
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
        // Older rows may not have claude_session_id persisted — fall back to the UI id, which
        // matches Claude's id for sessions that were originally imported from ~/.claude/projects.
        claudeSessionId: row.claude_session_id ?? row.id,
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

  resume(opts: { cwd: string; uiId: string; claudeSessionId: string; backlog?: StreamEvent[] }): SessionHandle {
    // Replace any existing detached handle under the same UI id before re-creating.
    this.sessions.delete(opts.uiId);
    const handle = this.create({
      cwd: opts.cwd,
      presetUiId: opts.uiId,
      resumeSessionId: opts.claudeSessionId,
    });
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
