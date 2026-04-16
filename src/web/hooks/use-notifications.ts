import { useEffect, useState, useCallback } from 'react';
import { subscribe } from '../lib/ws';
import type { ServerEnvelope } from '../../server/ws/envelope';
import type { Notification as ClaudexNotification } from '../../server/notifications';

export function useNotifications() {
  const [toasts, setToasts] = useState<ClaudexNotification[]>([]);

  const dismiss = useCallback((timestamp: number) => {
    setToasts((prev) => prev.filter((t) => t.timestamp !== timestamp));
  }, []);

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    const off = subscribe((env: ServerEnvelope) => {
      if (env.type === 'error') {
        const timestamp = Date.now();
        const n: ClaudexNotification = {
          sessionId: '',
          kind: 'tool-error',
          title: 'Server error',
          body: env.payload.message,
          timestamp,
        };
        setToasts((prev) => [...prev.slice(-4), n]);
        setTimeout(() => dismiss(timestamp), 8000);
        return;
      }
      if (env.type !== 'notification') return;
      const n = env.payload;
      setToasts((prev) => [...prev.slice(-4), n]);
      setTimeout(() => dismiss(n.timestamp), 5000);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const osNotif = new Notification(n.title, { body: n.body, tag: n.sessionId });
          osNotif.onclick = () => {
            window.focus();
            location.hash = '';
            location.href = `/session/${n.sessionId}`;
            osNotif.close();
          };
        } catch { /* no-op */ }
      }
    });
    return off;
  }, [dismiss]);

  return { toasts, dismiss };
}
