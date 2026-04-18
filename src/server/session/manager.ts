import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SessionProcess, type SessionProcessOptions } from './process.js';
import { DEFAULT_EFFORT, initialState, reduce, type EffortLevel, type SessionState } from './state.js';
import type { StreamEvent } from '../stream-json/types.js';
import type { SessionRow } from '../db.js';
import { createWorktree, removeWorktree, type WorktreeInfo } from '../worktree.js';

function legacyBranchName(uiId: string, label: string | null): string {
  const short = uiId.slice(0, 8);
  const slug = (label ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return slug ? `claudex/${slug}-${short}` : `claudex/${short}`;
}

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
  effort?: EffortLevel;
  resumeSessionId?: string;     // Claude's internal session id — forwarded to `claude --resume`.
  presetUiId?: string;          // Keep this UI id for the new handle (used by Resume to reuse the detached card's id).
  useWorktree?: boolean;        // Launch this session in a fresh git worktree off opts.cwd.
  /** Pre-created worktree metadata — set internally when rehydrating. */
  worktree?: WorktreeInfo;
  appendSystemPrompt?: string;  // Orientation hint stickied across turns via claude CLI.
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
    const effort = opts.effort ?? DEFAULT_EFFORT;

    // Worktree setup happens before spawning claude so the subprocess's cwd is the worktree.
    // `opts.worktree` is set when restart() wants to reuse the existing worktree; otherwise
    // `useWorktree` triggers a fresh `git worktree add`. Failure bubbles up to the WS hub.
    let worktree: WorktreeInfo | null = opts.worktree ?? null;
    if (!worktree && opts.useWorktree) {
      worktree = createWorktree(opts.cwd, localId, { branch: legacyBranchName(localId, opts.label ?? null) });
    }
    const effectiveCwd = worktree ? worktree.path : opts.cwd;

    const processOpts: SessionProcessOptions = {
      cwd: effectiveCwd,
      permissionMode: opts.permissionMode,
      resumeSessionId: opts.resumeSessionId,
      effort,
      appendSystemPrompt: opts.appendSystemPrompt,
      ...this.opts.spawnOverride?.(opts),
    };
    const proc = new SessionProcess(processOpts);
    const ringSizeForHandle = ringSize;
    const self = this;
    const handle = Object.assign(new EventEmitter(), {
      id: localId,
      state: {
        ...initialState(localId, effectiveCwd),
        claudeSessionId: opts.resumeSessionId ?? null,
        title: opts.label?.trim() || null,
        effort,
        worktreeOrigin: worktree?.origin ?? null,
        worktreeBranch: worktree?.branch ?? null,
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
        if (handle.state.status === 'idle') {
          handle.state = { ...handle.state, status: 'running' };
        }
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
      if (!this.sessions.has(handle.id)) return; // deleted — skip noisy 'crashed' broadcast
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
      if (!this.sessions.has(handle.id)) return;
      handle.state = { ...handle.state, status: 'crashed', error: err.message };
      handle.emit('ended', handle.state);
      this.emit('ended', handle);
    });

    // Register + emit 'created' immediately so the UI shows a card the moment the user launches.
    this.sessions.set(handle.id, handle);
    this.emit('created', handle);
    proc.start();
    if (opts.prompt) {
      handle.send(opts.prompt);
    } else {
      // No initial prompt — claude --input-format stream-json is silent until stdin (see
      // CLAUDE.md §5). Without this, the UI hangs on "starting Claude…" forever. Mark idle
      // so the composer is enabled; the first user message will wake the subprocess.
      handle.state = { ...handle.state, status: 'idle' };
      this.emit('updated', handle);
    }
    return handle;
  }

  interrupt(id: string): void {
    this.sessions.get(id)?.process?.interrupt();
  }

  kill(id: string): void {
    this.sessions.get(id)?.kill();
  }

  setTitle(id: string, title: string | null): void {
    const h = this.sessions.get(id);
    if (!h) return;
    const clean = title?.trim();
    h.state = { ...h.state, title: clean ? clean : null };
    this.emit('updated', h);
  }

  setEffort(id: string, effort: EffortLevel): void {
    const h = this.sessions.get(id);
    if (!h) return;
    if (h.state.effort === effort) return;
    h.state = { ...h.state, effort };
    this.emit('updated', h);
    // Inject as a user message so Claude CLI applies the slash command live. Reusing
    // handle.send echoes it into the event log for transparency and persists via stream-json.
    if (h.process && h.state.status !== 'detached' && h.state.status !== 'ended' && h.state.status !== 'crashed') {
      try { h.send(`/effort ${effort}`); } catch { /* process may have exited */ }
    }
  }

  restart(id: string): SessionHandle | undefined {
    const h = this.sessions.get(id);
    if (!h) return undefined;
    const { cwd, title, effort, worktreeOrigin, worktreeBranch } = h.state;
    // Drop the handle from the map before killing so the old subprocess's exit listener
    // doesn't broadcast a stale 'crashed' update for this id. Then spawn a fresh subprocess
    // under the same UI id with NO `--resume` flag — new claudeSessionId, empty context.
    this.sessions.delete(id);
    try { h.kill(); } catch { /* ignore */ }
    const next = this.create({
      cwd,
      presetUiId: id,
      effort,
      label: title ?? undefined,
      // Reset preserves the worktree — we want the same branch and working tree, just a
      // fresh conversation on top of it.
      worktree: worktreeOrigin && worktreeBranch
        ? { origin: worktreeOrigin, branch: worktreeBranch, path: cwd }
        : undefined,
    });
    // Same trick as resume(): a fresh `claude --input-format stream-json` subprocess emits no
    // system:init until the first stdin message arrives, so leaving status='starting' freezes
    // the UI on "starting Claude…". Mark it idle so the composer is enabled and the user
    // (or a broadcast) can wake it up.
    next.state = { ...next.state, status: 'idle' };
    this.emit('updated', next);
    return next;
  }

  delete(id: string): void {
    const h = this.sessions.get(id);
    if (!h) return;
    // Remove from the map and broadcast 'deleted' before killing so the exit listener
    // (which fires async) sees no entry and skips the 'crashed' broadcast that would
    // otherwise flicker into the dashboard before the row disappears.
    this.sessions.delete(id);
    this.emit('deleted', id);
    try { h.kill(); } catch { /* ignore */ }
    const { worktreeOrigin, cwd } = h.state;
    if (worktreeOrigin) {
      // Fire-and-forget; any git lock contention with the dying subprocess resolves quickly.
      try { removeWorktree(worktreeOrigin, cwd); } catch { /* ignore */ }
    }
  }

  registerDetached(row: SessionRow): SessionHandle {
    const handle = Object.assign(new EventEmitter(), {
      id: row.id,
      state: {
        ...initialState(row.id, row.cwd),
        // Only trust a persisted claude_session_id. Legacy rows that predate the column stay
        // null so the UI can mark them as non-resumable instead of passing the UI UUID to
        // `claude --resume` and getting a silent crash.
        claudeSessionId: row.claude_session_id,
        title: row.label,
        status: 'detached' as const,
        error: row.error,
        lastActivityAt: row.last_event_at,
        effort: (row.effort as EffortLevel | null) ?? DEFAULT_EFFORT,
        baselineCostUsd: row.cum_cost ?? 0,
        baselineTokens: { input: row.cum_in ?? 0, output: row.cum_out ?? 0 },
        turns: row.turns ?? 0,
        worktreeOrigin: row.worktree_origin,
        worktreeBranch: row.worktree_branch,
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
    const prev = this.sessions.get(opts.uiId)?.state;
    const prevTitle = prev?.title ?? null;
    const prevEffort = prev?.effort ?? DEFAULT_EFFORT;
    const prevWorktreeOrigin = prev?.worktreeOrigin ?? null;
    const prevWorktreeBranch = prev?.worktreeBranch ?? null;
    this.sessions.delete(opts.uiId);
    const handle = this.create({
      cwd: opts.cwd,
      presetUiId: opts.uiId,
      resumeSessionId: opts.claudeSessionId,
      effort: prevEffort,
      // Re-attach the existing worktree (already on disk) so the resumed session keeps
      // its branch + origin and groups under the same source repo on the dashboard.
      worktree: prevWorktreeOrigin && prevWorktreeBranch
        ? { origin: prevWorktreeOrigin, branch: prevWorktreeBranch, path: opts.cwd }
        : undefined,
    });
    if (prevTitle) handle.state = { ...handle.state, title: prevTitle };
    // Seed baselines from the detached handle so cumulative cost/tokens/turns survive the resume.
    // The detached state carries DB-loaded baselines plus any subprocess values from the prior run
    // (which are 0 on a fresh restart but non-zero for an in-memory resume cycle).
    if (prev) {
      handle.state = {
        ...handle.state,
        baselineCostUsd: prev.baselineCostUsd + prev.costUsd,
        baselineTokens: {
          input: prev.baselineTokens.input + prev.tokens.input,
          output: prev.baselineTokens.output + prev.tokens.output,
        },
        turns: prev.turns,
      };
    }
    // Replay backlog through reducer before live events arrive
    if (opts.backlog) {
      for (const ev of opts.backlog) {
        handle.state = reduce(handle.state, ev);
        handle.eventLog.push(ev);
      }
    }
    // Claude's `--resume --input-format stream-json` stays completely silent until the first user
    // message arrives on stdin — no system:init, nothing. If we leave status at 'starting' the UI
    // looks frozen; mark it 'idle' so the composer is enabled and the user knows to type.
    handle.state = { ...handle.state, status: 'idle' };
    this.emit('updated', handle);
    return handle;
  }
}
