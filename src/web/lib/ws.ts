import type { ClientEnvelope, ServerEnvelope } from '../../server/ws/envelope';

type Listener = (env: ServerEnvelope) => void;
type ConnListener = (state: ConnectionState) => void;

export type ConnectionState = 'connecting' | 'open' | 'closed';

const listeners = new Set<Listener>();
const connListeners = new Set<ConnListener>();
let ws: WebSocket | null = null;
let backlog: ClientEnvelope[] = [];
let connState: ConnectionState = 'connecting';

function setConn(s: ConnectionState): void {
  if (connState === s) return;
  connState = s;
  for (const l of connListeners) l(s);
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connect(): void {
  setConn('connecting');
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    console.log('[ws] connected');
    for (const env of backlog) ws?.send(JSON.stringify(env));
    backlog = [];
    setConn('open');
  };
  ws.onmessage = (e) => {
    try {
      const env = JSON.parse(e.data) as ServerEnvelope;
      for (const l of listeners) l(env);
    } catch (err) {
      console.error('[ws] parse error', err);
    }
  };
  ws.onclose = () => {
    console.log('[ws] disconnected, retrying in 1s');
    ws = null;
    setConn('closed');
    setTimeout(connect, 1000);
  };
  ws.onerror = (e) => console.error('[ws] error', e);
}

connect();

export function send(env: ClientEnvelope): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
  else backlog.push(env);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeConnection(listener: ConnListener): () => void {
  connListeners.add(listener);
  listener(connState);
  return () => { connListeners.delete(listener); };
}

export function getConnectionState(): ConnectionState {
  return connState;
}
