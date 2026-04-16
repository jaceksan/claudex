import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './session/manager.js';
import { NotificationEngine } from './notifications.js';
import { Db } from './db.js';
import { WsHub } from './ws/hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7878);

const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

const dbPath = process.env.CLAUDEX_DB ?? path.join(process.env.HOME ?? '.', '.claudex.sqlite');
const db = new Db(dbPath);
db.markAllDetached();

const manager = new SessionManager();
const notifications = new NotificationEngine();
const hub = new WsHub(manager, notifications, db);

// @fastify/websocket v10: handler receives (socket, request) directly
app.get('/ws', { websocket: true }, (socket) => hub.attach(socket));

app.get('/api/health', async () => ({ ok: true }));

const webDist = path.resolve(__dirname, '../web');
try {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
} catch { /* dev mode: Vite serves the frontend */ }

await app.listen({ host: '127.0.0.1', port: PORT });
app.log.info(`claudex listening on http://127.0.0.1:${PORT}`);
