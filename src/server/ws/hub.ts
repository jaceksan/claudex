import type { WebSocket } from 'ws';
import type { SessionManager } from '../session/manager.js';
import type { NotificationEngine } from '../notifications.js';
import type { Db } from '../db.js';
import type { ClientEnvelope, ServerEnvelope } from './envelope.js';
import type { TranscriptReader } from '../session/transcript.js';

export class WsHub {
  private readonly clients = new Set<WebSocket>();
  private readonly subs = new Map<WebSocket, Set<string>>(); // ws -> sessionIds

  constructor(
    private readonly manager: SessionManager,
    private readonly notifications: NotificationEngine,
    private readonly db: Db,
    private readonly transcripts: TranscriptReader,
  ) {
    manager.on('created', (h) => this.broadcast({ type: 'session.created', payload: { state: h.state } }));
    manager.on('event', (h, ev) => {
      this.db.upsertSession({ id: h.id, cwd: h.state.cwd, label: null, status: h.state.status });
      this.sendToSubscribers(h.id, { type: 'session.event', payload: { sessionId: h.id, event: ev } });
      this.broadcast({ type: 'session.updated', payload: { state: h.state } });
      notifications.handle(h.id, ev);
    });
    manager.on('ended', (h) => {
      this.db.upsertSession({ id: h.id, cwd: h.state.cwd, label: null, status: h.state.status, error: h.state.error });
      this.broadcast({ type: 'session.ended', payload: { state: h.state } });
    });
    manager.on('deleted', (id: string) => {
      this.db.deleteSession(id);
      this.broadcast({ type: 'session.deleted', payload: { sessionId: id } });
    });
    notifications.on('notification', (n) => this.broadcast({ type: 'notification', payload: n }));
  }

  attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.subs.set(ws, new Set());
    ws.on('message', (raw) => this.onMessage(ws, raw.toString()));
    ws.on('close', () => { this.clients.delete(ws); this.subs.delete(ws); });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let env: ClientEnvelope;
    try { env = JSON.parse(raw) as ClientEnvelope; }
    catch { return this.sendError(ws, 'invalid JSON'); }
    try {
      switch (env.type) {
        case 'client.listSessions':
          this.send(ws, { type: 'session.list', payload: { sessions: this.manager.list().map((h) => h.state) } });
          break;
        case 'client.subscribe': {
          this.subs.get(ws)?.add(env.payload.sessionId);
          const h = this.manager.get(env.payload.sessionId);
          if (h) {
            this.send(ws, {
              type: 'session.replay',
              payload: { state: h.state, events: [...h.eventLog] },
            });
          }
          break;
        }
        case 'client.unsubscribe':
          this.subs.get(ws)?.delete(env.payload.sessionId);
          break;
        case 'client.launch': {
          this.manager.create(env.payload);
          break;
        }
        case 'client.sendInput': {
          const h = this.manager.get(env.payload.sessionId);
          if (!h) return this.sendError(ws, 'no such session', env.requestId);
          h.send(env.payload.text);
          break;
        }
        case 'client.kill':
          this.manager.kill(env.payload.sessionId);
          break;
        case 'client.delete':
          this.manager.delete(env.payload.sessionId);
          break;
        case 'client.resume': {
          const id = env.payload.sessionId;
          const existing = this.manager.get(id);
          const cwd = existing?.state.cwd;
          if (!cwd) return this.sendError(ws, 'no session metadata for resume', env.requestId);
          const events = this.transcripts.readEvents(id);
          const h = this.manager.resume({ cwd, resumeSessionId: id, backlog: events });
          this.send(ws, { type: 'session.created', payload: { state: h.state } });
          break;
        }
      }
    } catch (e) {
      this.sendError(ws, (e as Error).message, env.requestId);
    }
  }

  private send(ws: WebSocket, env: ServerEnvelope): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(env));
  }

  private sendError(ws: WebSocket, message: string, requestId?: string): void {
    this.send(ws, { type: 'error', payload: { message, requestId } });
  }

  private broadcast(env: ServerEnvelope): void {
    for (const ws of this.clients) this.send(ws, env);
  }

  private sendToSubscribers(sessionId: string, env: ServerEnvelope): void {
    for (const [ws, ids] of this.subs) if (ids.has(sessionId)) this.send(ws, env);
  }
}
