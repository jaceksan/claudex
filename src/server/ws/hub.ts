import type { WebSocket } from 'ws';
import type { SessionManager } from '../session/manager.js';
import type { NotificationEngine } from '../notifications.js';
import type { Db } from '../db.js';
import type { ClientEnvelope, ServerEnvelope } from './envelope.js';
import type { TranscriptReader } from '../session/transcript.js';
import type { TopicManager } from '../topic-manager.js';
import type { PrLifecycle } from '../pr-lifecycle.js';
import type { PrCache } from '../pr-cache.js';
import type { RepoStore } from '../repo.js';
import type { TopicStore } from '../topic.js';
import type { TaskStore } from '../task.js';
import type { TopicCard, TaskRow, TopicDetailBundle } from './topic-envelope.js';
import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEffortLevel } from '../session/state.js';
import { savePrompt, mergePrompt, pushPrompt } from './task-prompts.js';

const execFileP = promisify(execFile);

export interface TopicDeps {
  topicManager: TopicManager;
  repos: RepoStore;
  topics: TopicStore;
  tasks: TaskStore;
  rawDb: Database.Database;
  prLifecycle?: PrLifecycle;
  prCache?: PrCache;
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

export async function buildTopicDetail(topicId: string, deps: TopicDeps): Promise<ServerEnvelope> {
  const topic = deps.topics.getById(topicId);
  if (!topic) throw new Error(`topic ${topicId} not found`);
  const repo = deps.repos.getById(topic.repoId)!;

  const taskSummary = topicTaskSummary(deps.tasks, deps.rawDb, topicId);
  const lastTask = deps.tasks.listByTopic(topicId)[0];
  const lastEventAt = lastTask
    ? (deps.rawDb.prepare('SELECT last_event_at FROM sessions WHERE id=?').get(lastTask.sessionId) as { last_event_at?: number } | undefined)?.last_event_at ?? topic.createdAt
    : topic.createdAt;

  const topicCard: TopicDetailBundle['topic'] = {
    id: topic.id, repoId: topic.repoId, phase: topic.phase,
    template: topic.template, ticketKey: topic.ticketKey,
    title: topic.title, topicBranch: topic.topicBranch,
    prNumber: topic.prNumber, taskSummary, lastEventAt,
    acceptedAttemptId: topic.acceptedAttemptId,
    watchCi: topic.watchCi,
    slug: topic.slug,
    repoPath: repo.path,
    repoDefaultBranch: repo.defaultBranch,
  };

  const taskRows: TaskRow[] = deps.tasks.listByTopic(topicId).map((t) => {
    const sessRow = deps.rawDb.prepare('SELECT status FROM sessions WHERE id=?').get(t.sessionId) as { status?: string } | undefined;
    return {
      sessionId: t.sessionId, topicId: t.topicId, type: t.type,
      label: t.label, childBranch: t.childBranch,
      acceptedAt: t.acceptedAt, discardedAt: t.discardedAt,
      sessionStatus: sessRow?.status ?? 'ended',
    };
  });

  const deliveryTask = taskRows.find((t) => t.type === 'delivery' && !t.discardedAt);
  const deliverable = deps.topicManager
    ? await deps.topicManager.computeDeliverable(topicId).catch((): { ok: false; reasons: string[] } => ({
        ok: false, reasons: ['Could not determine deliverable state.'],
      }))
    : { ok: false, reasons: ['Topic manager not initialised.'] };

  const bundle: TopicDetailBundle = {
    topicId, topic: topicCard, tasks: taskRows,
    deliverable,
    deliverySessionId: deliveryTask?.sessionId ?? null,
    deliverySessionStatus: deliveryTask?.sessionStatus ?? null,
  };

  if ((topic.phase === 'Open' || topic.phase === 'Draft') && topic.prNumber && deps.prCache && repo) {
    try {
      const prBundle = await deps.prCache.get(repo.path, topic.prNumber, repo.defaultBranch);
      bundle.pr = prBundle.pr;
      bundle.threads = prBundle.threads;
      bundle.checks = prBundle.checks;
      bundle.required = prBundle.requiredContexts;
    } catch (e) {
      console.error('[hub] buildTopicDetail prCache error:', e);
    }
  }

  return { type: 'server.topic.detail', payload: bundle };
}

export class WsHub {
  private readonly clients = new Set<WebSocket>();
  private readonly subs = new Map<WebSocket, Set<string>>(); // ws -> sessionIds
  private readonly topicSubs = new Map<WebSocket, Set<string>>(); // ws -> topicIds
  private topicDeps: TopicDeps | null = null;

  constructor(
    private readonly manager: SessionManager,
    private readonly notifications: NotificationEngine,
    private readonly db: Db,
    private readonly transcripts: TranscriptReader,
    topicDeps?: TopicDeps,
  ) {
    if (topicDeps) this.topicDeps = topicDeps;
    manager.on('created', (h) => {
      // Persist the row immediately so downstream code (e.g. task.create with a FK
      // on sessions.id) can reference the session before Claude CLI emits its first
      // stream event. Prompt-less spawns stay silent until the user types, so we
      // can't rely on the 'event' handler here.
      this.db.upsertSession({ id: h.id, claudeSessionId: h.state.claudeSessionId, cwd: h.state.cwd, label: h.state.title, status: h.state.status, effort: h.state.effort, worktreeOrigin: h.state.worktreeOrigin, worktreeBranch: h.state.worktreeBranch });
      this.broadcast({ type: 'session.created', payload: { state: h.state } });
    });
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
    this.topicSubs.set(ws, new Set());
    ws.on('message', (raw) => this.onMessage(ws, raw.toString()));
    ws.on('close', () => { this.clients.delete(ws); this.subs.delete(ws); this.topicSubs.delete(ws); });
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
          const { repoId, template, title, ticketKey, typeField, project, branchOverride } = env.payload;
          td.topicManager.create({
            repoId, template, title, ticketKey, type: typeField, project, branchOverride,
          }).then(({ topic }) => {
            this.broadcast({ type: 'server.topic.created', payload: { topicId: topic.id } });
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
          td.topicManager.addAttempt(topicId, attemptArgs).then(async () => {
            this.broadcast(buildTopicState(td));
            try {
              this.broadcast(await buildTopicDetail(topicId, td));
            } catch { /* best-effort */ }
          }).catch((e: Error) => {
            console.error('[addAttempt]', e);
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'addAttempt' } });
          });
          break;
        }
        case 'client.topic.previewBranch': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { repoId, title, ticketKey, override } = env.payload;
          const repo = td.repos.getById(repoId);
          if (!repo) return this.sendError(ws, 'unknown repo');
          (async () => {
            let branch = override?.trim() ?? '';
            if (!branch) {
              const { slugify } = await import('../slug.js');
              const { renderBranchTemplate } = await import('../branch-template.js');
              const { getOrFetchGithubLogin } = await import('../identity.js');
              const { GitHubAdapter } = await import('../vcs/github.js');
              const ghUser = await getOrFetchGithubLogin(td.rawDb, new GitHubAdapter()).catch(() => '');
              branch = renderBranchTemplate(repo.branchTemplate, {
                gh_user: ghUser, ticket: ticketKey ?? '', slug: slugify(title),
                type: '', project: '',
              });
            }
            const localExists = (await execFileP('git', ['branch', '--list', branch], { cwd: repo.path }).then((r) => r.stdout).catch(() => '')).trim() !== '';
            const dup = td.rawDb.prepare('SELECT id, title FROM topic WHERE repo_id=? AND topic_branch=?').get(repo.id, branch) as { id: string; title: string } | undefined;
            this.send(ws, {
              type: 'server.topic.branchPreview',
              payload: {
                branch,
                localBranchExists: localExists,
                duplicateTopic: dup ?? null,
              },
            });
          })().catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'previewBranch' } });
          });
          break;
        }
        case 'client.topic.delete': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          td.topicManager.deleteTopic(env.payload.topicId).then(() => {
            this.broadcast(buildTopicState(td));
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'delete' } });
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
        case 'client.session.siblings': {
          const td = this.topicDeps;
          if (!td) {
            this.send(ws, { type: 'server.session.siblings', payload: { sessionId: env.payload.sessionId, topicId: null, siblings: [] } });
            break;
          }
          const task = td.tasks.getBySession(env.payload.sessionId);
          if (!task) {
            this.send(ws, { type: 'server.session.siblings', payload: { sessionId: env.payload.sessionId, topicId: null, siblings: [] } });
            break;
          }
          const siblingTasks = td.tasks.listByTopic(task.topicId);
          const siblings = siblingTasks.map((t) => {
            const row = td.rawDb.prepare('SELECT status, title, cwd, last_event_at FROM sessions WHERE id=?').get(t.sessionId) as { status?: string; title?: string | null; cwd?: string; last_event_at?: number } | undefined;
            return {
              sessionId: t.sessionId,
              topicId: t.topicId,
              type: t.type,
              label: t.label,
              title: row?.title ?? null,
              cwd: row?.cwd ?? '',
              status: row?.status ?? 'ended',
              lastActivityAt: row?.last_event_at ?? 0,
              acceptedAt: t.acceptedAt,
              discardedAt: t.discardedAt,
            };
          });
          this.send(ws, { type: 'server.session.siblings', payload: { sessionId: env.payload.sessionId, topicId: task.topicId, siblings } });
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
          // Replay to every subscriber (this socket plus any other open tab) so their
          // event list is repopulated from the transcript. session.created alone only
          // delivers state, leaving the UI's events array empty after resume.
          this.sendToSubscribers(h.id, {
            type: 'session.replay',
            payload: { state: h.state, events: [...h.eventLog] },
          });
          break;
        }
        case 'client.topic.subscribe': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { topicId } = env.payload;
          this.topicSubs.get(ws)?.add(topicId);
          buildTopicDetail(topicId, td).then((detail) => {
            this.send(ws, detail);
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'subscribe' } });
          });
          break;
        }
        case 'client.topic.unsubscribe': {
          this.topicSubs.get(ws)?.delete(env.payload.topicId);
          break;
        }
        case 'client.task.save': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { sessionId } = env.payload;
          const task = td.tasks.getBySession(sessionId);
          if (!task) return this.send(ws, { type: 'server.topic.error', payload: { message: 'No task for that session.', ctx: 'save' } });
          const topic = td.topics.getById(task.topicId);
          if (!topic) return this.send(ws, { type: 'server.topic.error', payload: { message: 'No topic for that task.', ctx: 'save' } });
          const h = this.manager.get(sessionId);
          if (!h) return this.send(ws, { type: 'server.topic.error', payload: { message: 'Session is not running. Resume it first.', ctx: 'save' } });
          if (h.state.status === 'running' || h.state.status === 'starting') {
            return this.send(ws, { type: 'server.topic.error', payload: { message: 'Claude is busy — wait until idle and try again.', ctx: 'save' } });
          }
          h.send(savePrompt({ topicTitle: topic.title, taskLabel: task.label, ticketKey: topic.ticketKey }));
          break;
        }
        case 'client.task.discardChanges': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { sessionId } = env.payload;
          const task = td.tasks.getBySession(sessionId);
          td.topicManager.discardTaskChanges(sessionId).then(async () => {
            this.broadcast(buildTopicState(td));
            if (task) {
              const detail = await buildTopicDetail(task.topicId, td);
              this.broadcastTopicDetail(task.topicId, detail);
            }
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'discardChanges' } });
          });
          break;
        }
        case 'client.task.discardHard': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { sessionId } = env.payload;
          const task = td.tasks.getBySession(sessionId);
          td.topicManager.discardTaskHard(sessionId).then(async () => {
            this.broadcast(buildTopicState(td));
            if (task) {
              try {
                const detail = await buildTopicDetail(task.topicId, td);
                this.broadcastTopicDetail(task.topicId, detail);
              } catch { /* topic may also be gone */ }
            }
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'discardHard' } });
          });
          break;
        }
        case 'client.task.merge': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { sessionId } = env.payload;
          const task = td.tasks.getBySession(sessionId);
          if (!task) return this.send(ws, { type: 'server.topic.error', payload: { message: 'No task for that session.', ctx: 'merge' } });
          const topic = td.topics.getById(task.topicId);
          if (!topic) return this.send(ws, { type: 'server.topic.error', payload: { message: 'No topic for that task.', ctx: 'merge' } });
          const repo = td.repos.getById(topic.repoId);
          if (!repo) return this.send(ws, { type: 'server.topic.error', payload: { message: 'No repo for that topic.', ctx: 'merge' } });
          const h = this.manager.get(sessionId);
          if (!h) return this.send(ws, { type: 'server.topic.error', payload: { message: 'Session is not running. Resume it first.', ctx: 'merge' } });
          if (h.state.status === 'running' || h.state.status === 'starting') {
            return this.send(ws, { type: 'server.topic.error', payload: { message: 'Claude is busy — wait until idle and try again.', ctx: 'merge' } });
          }
          if (!topic.topicBranch || !task.childBranch) {
            return this.send(ws, { type: 'server.topic.error', payload: { message: 'Task or topic is missing branch info.', ctx: 'merge' } });
          }
          h.send(mergePrompt({
            topicBranch: topic.topicBranch,
            taskBranch: task.childBranch,
            repoPath: repo.path,
            topicTitle: topic.title,
            taskLabel: task.label,
            ticketKey: topic.ticketKey,
          }));
          break;
        }
        case 'client.topic.push': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          const { topicId } = env.payload;
          (async () => {
            const topic = td.topics.getById(topicId);
            if (!topic || !topic.topicBranch) throw new Error('No branch to push.');
            const repo = td.repos.getById(topic.repoId)!;

            const deliverable = await td.topicManager.computeDeliverable(topicId);
            if (!deliverable.ok) throw new Error(`Topic not ready to push: ${deliverable.reasons.join(' ')}`);

            const { sessionId, spawned } = await td.topicManager.ensureDeliverySession(topicId);
            this.broadcast(buildTopicState(td));
            const detail = await buildTopicDetail(topicId, td);
            this.broadcastTopicDetail(topicId, detail);

            // Give a freshly-spawned stream-json subprocess a moment to hit idle
            // (see CLAUDE.md §5 — it stays silent until stdin).
            if (spawned) await new Promise((r) => setTimeout(r, 250));

            const h = this.manager.get(sessionId);
            if (!h) throw new Error('Delivery session vanished before prompt could be sent.');
            if (h.state.status === 'running' || h.state.status === 'starting') {
              throw new Error('Delivery session is busy — wait until idle and try again.');
            }
            h.send(pushPrompt({
              topicBranch: topic.topicBranch,
              topicTitle: topic.title,
              ticketKey: topic.ticketKey,
              forkRemote: repo.forkRemote,
            }));
          })().catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'push' } });
          });
          break;
        }
        case 'client.pr.create': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          if (!td.prLifecycle) return this.sendError(ws, 'PR lifecycle not initialised');
          const { topicId, title, body } = env.payload;
          td.prLifecycle.createPR(topicId, { title, body }).then(async () => {
            this.broadcast(buildTopicState(td));
            const detail = await buildTopicDetail(topicId, td);
            this.broadcastTopicDetail(topicId, detail);
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'createPR' } });
          });
          break;
        }
        case 'client.pr.addressFeedback': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          if (!td.prLifecycle) return this.sendError(ws, 'PR lifecycle not initialised');
          const { topicId, includeCi, includeComments } = env.payload;
          td.prLifecycle.addressFeedback(topicId, { includeCi, includeComments }).then(async () => {
            this.broadcast(buildTopicState(td));
            const detail = await buildTopicDetail(topicId, td);
            this.broadcastTopicDetail(topicId, detail);
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'addressFeedback' } });
          });
          break;
        }
        case 'client.pr.fixComment': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          if (!td.prLifecycle) return this.sendError(ws, 'PR lifecycle not initialised');
          const { topicId, threadId } = env.payload;
          td.prLifecycle.fixComment(topicId, threadId).then(async () => {
            this.broadcast(buildTopicState(td));
            const detail = await buildTopicDetail(topicId, td);
            this.broadcastTopicDetail(topicId, detail);
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'fixComment' } });
          });
          break;
        }
        case 'client.pr.fixCheck': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          if (!td.prLifecycle) return this.sendError(ws, 'PR lifecycle not initialised');
          const { topicId, checkName } = env.payload;
          td.prLifecycle.fixCheck(topicId, checkName).then(async () => {
            this.broadcast(buildTopicState(td));
            const detail = await buildTopicDetail(topicId, td);
            this.broadcastTopicDetail(topicId, detail);
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'fixCheck' } });
          });
          break;
        }
        case 'client.pr.watch': {
          const td = this.topicDeps;
          if (!td) return this.sendError(ws, 'topic support not initialised');
          if (!td.prLifecycle) return this.sendError(ws, 'PR lifecycle not initialised');
          const { topicId, enable } = env.payload;
          td.prLifecycle.watchCi(topicId, enable).then(async () => {
            const detail = await buildTopicDetail(topicId, td);
            this.broadcastTopicDetail(topicId, detail);
          }).catch((e: Error) => {
            this.send(ws, { type: 'server.topic.error', payload: { message: e.message, ctx: 'watch' } });
          });
          break;
        }
        case 'client.thread.reply': {
          // Stub — logs and acknowledges; real reply path goes through prLifecycle in a later plan.
          const { topicId, threadId, body } = env.payload;
          console.log(`[hub] thread.reply stub: topic=${topicId} thread=${threadId} body=${body.slice(0, 80)}`);
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

  private broadcastTopicDetail(topicId: string, env: ServerEnvelope): void {
    for (const [ws, ids] of this.topicSubs) {
      if (ids.has(topicId)) this.send(ws, env);
    }
  }

  /**
   * Public entrypoint used by backend poll loops (pr-lifecycle CI watcher)
   * to push fresh topic detail to subscribed clients. Builds the bundle and
   * sends it to any socket currently subscribed to that topic.
   */
  async refreshTopicDetail(topicId: string): Promise<void> {
    const td = this.topicDeps;
    if (!td) return;
    try {
      const detail = await buildTopicDetail(topicId, td);
      this.broadcastTopicDetail(topicId, detail);
      // Also refresh the dashboard summary so task counts / phase tags stay in sync.
      this.broadcast(buildTopicState(td));
    } catch (e) {
      console.error('[hub] refreshTopicDetail error:', e);
    }
  }
}
