import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './session/manager.js';
import { NotificationEngine } from './notifications.js';
import { Db } from './db.js';
import { WsHub } from './ws/hub.js';
import { TranscriptReader } from './session/transcript.js';
import { getGitInfo } from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7878);

const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

const dbPath = process.env.CLAUDEX_DB ?? path.join(process.env.HOME ?? '.', '.claudex.sqlite');
const db = new Db(dbPath);
db.markAllDetached();

const manager = new SessionManager();
const notifications = new NotificationEngine();
const transcripts = new TranscriptReader();
const hub = new WsHub(manager, notifications, db, transcripts);

// Hydrate detached sessions from SQLite so they appear in the dashboard
for (const row of db.listSessions()) {
  if (row.status === 'detached') manager.registerDetached(row);
}

// @fastify/websocket v10: handler receives (socket, request) directly
app.get('/ws', { websocket: true }, (socket) => hub.attach(socket));

app.get('/api/health', async () => ({ ok: true }));

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
