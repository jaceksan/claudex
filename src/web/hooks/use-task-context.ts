import { useEffect, useState } from 'react';
import type { TaskContext } from '../../server/task-context';

export function useTaskContext(sessionId: string | undefined, intervalMs = 10_000): TaskContext | null {
  const [ctx, setCtx] = useState<TaskContext | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const fetchOnce = async () => {
      try {
        const r = await fetch(`/api/sessions/${sessionId}/task-context`);
        if (!r.ok) return;
        const data = (await r.json()) as TaskContext | null;
        if (alive) setCtx(data);
      } catch {/* ignore */}
    };
    fetchOnce();
    const t = setInterval(fetchOnce, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [sessionId, intervalMs]);
  return ctx;
}
