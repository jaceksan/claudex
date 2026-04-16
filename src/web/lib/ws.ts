import type { ClientEnvelope, ServerEnvelope } from '../../server/ws/envelope';

type Listener = (env: ServerEnvelope) => void;

const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let backlog: ClientEnvelope[] = [];

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connect(): void {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    console.log('[ws] connected');
    for (const env of backlog) ws?.send(JSON.stringify(env));
    backlog = [];
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
