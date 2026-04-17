import type { WebSocket } from 'ws';
import type { SessionManager } from '../session/manager.js';
import type { NotificationEngine } from '../notifications.js';
import type { Db } from '../db.js';
import type { ClientEnvelope, ServerEnvelope } from './envelope.js';
import type { TranscriptReader } from '../session/transcript.js';
import type { TopicManager } from '../topic-manager.js';
import type { RepoStore } from '../repo.js';
import type { TopicStore } from '../topic.js';
import type { TaskStore } from '../task.js';
import type { TopicCard } from './topic-envelope.js';
import type Database from 'better-sqlite3';
import { isEffortLevel } from '../session/state.js';

export interface TopicDeps {
  topicManager: TopicManager;
  repos: RepoStore;
  topics: TopicStore;
  tasks: TaskStore;
  rawDb: Database.Database;
}

function topicTaskSummary(tasks: TaskStore, rawDb: Database.Database, topicId: string) {
  const rows = tasks.listByTopic(topicId);
  let running = 0, accepted = 0, discarded = 0;
  for (const t of rows) {
    const s = rawDb.prepare('SELECT status FROM sessions WHERE id=?').get(t.sessionId) as { status?: string } | undefined;
    if (t.acceptedAt) accepted++;
    else if (t.discardedAt) discarded++;
    else if (s?.status === 'running') running++;
  }
  return { running, accepted, discarded };
}

function buildTopicState(deps: TopicDeps): ServerEnvelope {
  const repoList = deps.repos.list();
  const topicCards: TopicCard[] = [];
  for (const repo of repoList) {
    const repoTopics = deps.topics.listByRepo(repo.id);
    for (const topic of repoTopics) {
      const taskSummary = topicTaskSummary(deps.tasks, deps.rawDb, topic.id);
      const lastTask = deps.tasks.listByTopic(topic.id)[0];
      const lastEventAt = lastTask
        ? (deps.rawDb.prepare('SELECT last_event_at FROM sessions WHERE id=?').get(lastTask.sessionId) as { last_event_at?: number } | undefined)?.last_event_at ?? topic.createdAt
        : topic.createdAt;
      topicCards.push({
        id: topic.id, repoId: topic.repoId, phase: topic.phase,
        template: topic.template, ticketKey: topic.ticketKey,
        title: topic.title, topicBranch: topic.topicBranch,
        prNumber: topic.prNumber, taskSummary, lastEventAt,
      });
    }
  }
  return { type: 'server.topic.state', payload: { topics: topicCards } };
}

export class WsHub {
  private readonly clients = new Set<WebSocket>();
  private readonly subs = new Map<WebSocket, Set<string>>(); // ws -> sessionIds
  private topicDeps: TopicDeps | null = null;

  constructor(
    private readonly manager: SessionManager,
    private readonly notifications: NotificationEngine,
    private readonly db: Db,
    private readonly transcripts: TranscriptReader,
    topicDeps?: TopicDeps,
  ) {
    if (topicDeps) this.topicDeps = topicDeps;
    manager.on('created', (h) => this.broadcast({ type: 'session.created', payload: { state: h.state } }));
    manager.on('event', (h, ev) => {
      this.db.upsertSession({ id: h.id, claudeSessionId: h.state.claudeSessionId, cwd: h.state.cwd, label: h.state.title, status: h.state.status, effort: h.state.effort, worktreeOrigin: h.state.worktreeOrigin, worktreeBranch: h.state.worktreeBranch });
      const s = h.state;
      this.db.setUsage(
        h.id,
        s.baselineCostUsd + s.costUsd,
        s.baselineTokens.input + s.tokens.input,
        s.baselineTokens.output + s.tokens.output,
        s.turns,
      );
      this.sendToSubscribers(h.id, { type: 'session.event', payload: { sessionId: h.id, event: ev } });
      this.broadcast({ type: 'session.updated', payload: { state: h.state } });
      notifications.handle({ sessionId: h.id, title: h.state.title }, ev);
    });
    manager.on('updated', (h) => {
      this.db.setLabel(h.id, h.state.title);
      this.db.setEffort(h.id, h.state.effort);
      this.broadcast({ type: 'session.updated', payload: { state: h.state } });
    });
    manager.on('ended', (h) => {
      this.db.upsertSession({ id: h.id, claudeSessionId: h.state.claudeSessionId, cwd: h.state.cwd, label: h.state.title, status: h.state.status, effort: h.state.effort, error: h.state.error, worktreeOrigin: h.state.worktreeOrigin, worktreeBranch: h.state.worktreeBranch });
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
          const { effort, useWorktree, ...rest } = env.payload;
          try {
            this.manager.create({
              ...rest,
              useWorktree,
              effort: effort && isEffortLevel(effort) ? effort : undefined,
            });
          } catch (e) {
            // Worktree creation is the most common failure here — surface it so the user
            // knows why their session didn't launch instead of staring at an empty dashboard.
            return this.sendError(ws, (e as Error).message, env.requestId);
          }
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
        case 'client.restart': {
          const h = this.manager.restart(env.payload.sessionId);
          if (!h) return this.sendError(ws, 'no such session', env.requestId);
          this.db.setUsage(h.id, 0, 0, 0, 0);
          // Null the stale claude_session_id in the DB so a server restart before the first
          // event of the new subprocess doesn't rehydrate with a pointer to the old convo.
          this.db.clearClaudeSessionId(h.id);
          // Push a replay to all subscribers of this session so their event lists reset.
          this.sendToSubscribers(h.id, {
            type: 'session.replay',
            payload: { state: h.state, events: [...h.eventLog] },
          });
          break;
        }
        case 'client.interrupt':
          this.manager.interrupt(env.payload.sessionId);
          break;
        case 'client.delete':
          this.manager.delete(env.payload.sessionId);
          break;
        case 'client.rename':
          this.manager.setTitle(env.payload.sessionId, env.payload.title);
          break;
        case 'client.setEffort':
          if (!isEffortLevel(env.payload.effort)) return this.sendError(ws, 'invalid effort level', env.requestId);
          this.manager.setEffort(env.payload.sessionId, env.payload.effort);
          break;
        case 'client.topic.create': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { repoId, template, title, ticketKey, typeField, project, firstTask } = env.payload;
          td.topicManager.create({
            repoId, template, title, ticketKey, type: typeField, project, firstTask,
          }).then(({ topic, task }) => {
            this.broadcast({ type: 'server.topic.created', payload: { topicId: topic.id, sessionId: task.sessionId } });
            this.broadcast(buildTopicState(td));
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'create' } });
          });
          break;
        }
        case 'client.topic.addAttempt': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { topicId, ...attemptArgs } = env.payload;
          td.topicManager.addAttempt(topicId, attemptArgs).then(() => {
            this.broadcast(buildTopicState(td));
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'addAttempt' } });
          });
          break;
        }
        case 'client.topic.accept': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          td.topicManager.acceptAttempt(env.payload.sessionId).then(() => {
            this.broadcast(buildTopicState(td));
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'accept' } });
          });
          break;
        }
        case 'client.topic.discard': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          td.topicManager.discardAttempt(env.payload.sessionId).then(() => {
            this.broadcast(buildTopicState(td));
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'discard' } });
          });
          break;
        }
        case 'client.topic.list': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          this.send(ws, buildTopicState(td));
          break;
        }
        case 'client.repo.list': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const repos = td.repos.list().map((r) => ({
            id: r.id, path: r.path, vcsKind: r.vcsKind, defaultBranch: r.defaultBranch,
            canonicalOwner: r.canonicalOwner, canonicalName: r.canonicalName,
          }));
          this.send(ws, { type: 'server.repo.state', payload: { repos } });
          break;
        }
        case 'client.resume': {
          const uiId = env.payload.sessionId;
          const existing = this.manager.get(uiId);
          if (!existing) return this.sendError(ws, 'no session metadata for resume', env.requestId);
          const claudeId = existing.state.claudeSessionId;
          if (!claudeId) {
            return this.sendError(
              ws,
              'Cannot resume this session — its Claude session id was not recorded. Delete it and start a new one.',
              env.requestId,
            );
          }
          // Verify the transcript exists before spawning; otherwise `claude --resume` will crash
          // immediately with "No conversation found …" and leave a polluted row behind.
          const transcriptPath = this.transcripts.findTranscript(claudeId);
          if (!transcriptPath) {
            return this.sendError(
              ws,
              `Cannot resume session: no Claude transcript found for id ${claudeId}. Delete this session and start a new one.`,
              env.requestId,
            );
          }
          const cwd = existing.state.cwd;
          const events = this.transcripts.readEvents(claudeId);
          const h = this.manager.resume({ cwd, uiId, claudeSessionId: claudeId, backlog: events });
          this.send(ws, { type: 'session.created', payload: { state: h.state } });
          break;
        }
      }
    } catch (e) {
      this.sendError(ws, (e as Error).message, (env as { requestId?: string }).requestId);
    }
  }

  private send(ws: WebSocket, env: ServerEnvelope): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(env));
  }

  private sendError(ws: WebSocket, message: string, requestId?: string): void {
    this.send(ws, { type: 'error', payload: { message, requestId } });
  }

  broadcast(env: ServerEnvelope): void {
    for (const ws of this.clients) this.send(ws, env);
  }

  private sendToSubscribers(sessionId: string, env: ServerEnvelope): void {
    for (const [ws, ids] of this.subs) if (ids.has(sessionId)) this.send(ws, env);
  }
}
