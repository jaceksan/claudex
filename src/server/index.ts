import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionManager } from './session/manager.js';
import { NotificationEngine } from './notifications.js';
import { Db } from './db.js';
import { WsHub } from './ws/hub.js';
import { TranscriptReader } from './session/transcript.js';
import { getGitInfo } from './git.js';
import { getTaskContext } from './task-context.js';
import { getCommands } from './commands.js';
import { runMigrations } from './migration.js';
import { TopicManager } from './topic-manager.js';
import { RepoStore } from './repo.js';
import { TopicStore } from './topic.js';
import { TaskStore } from './task.js';
import { createWorktree, resolveGitRoot } from './worktree.js';
import { getOrFetchGithubLogin } from './identity.js';
import { GitHubAdapter } from './vcs/github.js';
import { PrLifecycle } from './pr-lifecycle.js';
import { PrCache } from './pr-cache.js';
import { onSessionEnded } from './quick-fix-auto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7878);

// Keep the process alive + log loudly when something unexpected throws; otherwise
// tsx watch leaves a dead server behind because it only restarts on file changes.
process.on('unhandledRejection', (err) => {
  console.error('[claudex] unhandledRejection', err);
});
process.on('uncaughtException', (err) => {
  console.error('[claudex] uncaughtException', err);
});

const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

const dbPath = process.env.CLAUDEX_DB ?? path.join(process.env.HOME ?? '.', '.claudex.sqlite');
const db = new Db(dbPath);
runMigrations(db.underlying());
db.markAllDetached();

const execFileP = promisify(execFile);

const manager = new SessionManager();
const notifications = new NotificationEngine();
const transcripts = new TranscriptReader();

const repos = new RepoStore(db.underlying());
const topics = new TopicStore(db.underlying());
const tasks = new TaskStore(db.underlying());

const topicManager = new TopicManager({
  db: db.underlying(),
  repos, topics, tasks,
  git: async (args, cwd) => execFileP('git', args, { cwd: cwd ?? process.cwd() }).then((r) => r.stdout),
  createWorktree: (cwd, id, opts) => createWorktree(cwd, id, opts),
  spawnSession: async ({ cwd, label, prompt, effort, permissionMode, presetUiId, worktree }) => {
    const s = manager.create({
      cwd, label: label ?? undefined, prompt,
      effort: effort as Parameters<typeof manager.create>[0]['effort'],
      permissionMode,
      presetUiId,
      worktree,
    });
    return { id: s.id };
  },
  deleteSession: (sessionId) => manager.delete(sessionId),
  now: () => Date.now(),
  githubLogin: async () => getOrFetchGithubLogin(db.underlying(), new GitHubAdapter()),
});

const ghAdapter = new GitHubAdapter();
const prCache = new PrCache(ghAdapter);
const prLifecycle = new PrLifecycle({
  repos,
  topics,
  adapter: () => ghAdapter,
  prCache,
  git: async (args, cwd) => execFileP('git', args, { cwd: cwd ?? process.cwd() }).then((r) => r.stdout),
  topicManager,
});

const hub = new WsHub(manager, notifications, db, transcripts, { topicManager, repos, topics, tasks, rawDb: db.underlying() });

// Auto-accept + auto-PR for quick-fix topics on session success.
manager.on('ended', (h) => {
  onSessionEnded(h.id, h.state.status, {
    tasks,
    topics,
    acceptAttempt: (sid) => topicManager.acceptAttempt(sid),
    createPR: (topicId, args) => prLifecycle.createPR(topicId, args),
  }).catch((e) => console.error('[quick-fix-auto] unexpected error', e));
});

// Hydrate detached sessions from SQLite so they appear in the dashboard
for (const row of db.listSessions()) {
  if (row.status === 'detached') manager.registerDetached(row);
}

// @fastify/websocket v10: handler receives (socket, request) directly
app.get('/ws', { websocket: true }, (socket) => hub.attach(socket));

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/commands', async () => {
  const cat = await getCommands();
  return { entries: cat.entries };
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/git', async (req, reply) => {
  const h = manager.get(req.params.id);
  if (!h) return reply.code(404).send({ error: 'no such session' });
  const info = await getGitInfo(h.state.cwd);
  return info;
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/task-context', async (req, reply) => {
  const h = manager.get(req.params.id);
  if (!h) return reply.code(404).send({ error: 'no such session' });
  const ctx = await getTaskContext({ tasks, topics, repos }, req.params.id, h.state.cwd);
  return ctx;
});

app.post('/api/repo/register', async (req, reply) => {
  const body = req.body as { path: string } | undefined;
  if (!body?.path) return reply.code(400).send({ error: 'path required' });
  const root = resolveGitRoot(body.path);
  if (!root) return reply.code(400).send({ error: 'not a git repo' });
  const existing = repos.getByPath(root);
  if (existing) return reply.send(existing);
  try {
    const adapter = new GitHubAdapter();
    const summary = await adapter.getRepo(root);
    const isFork = !!summary.parentOwner;
    const repo = repos.register({
      path: root, vcsKind: 'github',
      canonicalRemote: isFork ? 'upstream' : 'origin',
      forkRemote: 'origin',
      defaultBranch: summary.defaultBranch,
      canonicalOwner: isFork ? summary.parentOwner : summary.owner,
      canonicalName: isFork ? summary.parentName : summary.name,
      forkOwner: summary.owner, forkName: summary.name,
    });
    hub.broadcast({ type: 'server.repo.state', payload: { repos: repos.list().map((r) => ({
      id: r.id, path: r.path, vcsKind: r.vcsKind, defaultBranch: r.defaultBranch,
      canonicalOwner: r.canonicalOwner, canonicalName: r.canonicalName,
    })) } });
    return reply.send(repo);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

const webDist = path.resolve(__dirname, '../web');
try {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
} catch { /* dev mode: Vite serves the frontend */ }

await app.listen({ host: '127.0.0.1', port: PORT });
app.log.info(`claudex listening on http://127.0.0.1:${PORT}`);
