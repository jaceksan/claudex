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
import { getCommands } from './commands.js';
import { runMigrations } from './migration.js';
import { TopicManager } from './topic-manager.js';
import { RepoStore } from './repo.js';
import { TopicStore } from './topic.js';
import { TaskStore } from './task.js';
import { createWorktree } from './worktree.js';
import { getOrFetchGithubLogin } from './identity.js';
import { GitHubAdapter } from './vcs/github.js';

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
  spawnSession: async ({ cwd, label, prompt, effort, permissionMode }) => {
    const s = manager.create({ cwd, label: label ?? undefined, prompt, effort: effort as Parameters<typeof manager.create>[0]['effort'], permissionMode });
    return { id: s.id };
  },
  now: () => Date.now(),
  githubLogin: async () => getOrFetchGithubLogin(db.underlying(), new GitHubAdapter()),
});

const hub = new WsHub(manager, notifications, db, transcripts, { topicManager, repos, topics, tasks, rawDb: db.underlying() });

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

const webDist = path.resolve(__dirname, '../web');
try {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
} catch { /* dev mode: Vite serves the frontend */ }

await app.listen({ host: '127.0.0.1', port: PORT });
app.log.info(`claudex listening on http://127.0.0.1:${PORT}`);
