import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskContext } from '../../server/task-context';

export function useTaskContext(
  sessionId: string | undefined,
  intervalMs = 10_000,
): [TaskContext | null, () => void] {
  const [ctx, setCtx] = useState<TaskContext | null>(null);
  const fetchRef = useRef<() => void>(() => {});
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
    fetchRef.current = () => { void fetchOnce(); };
    fetchOnce();
    const t = setInterval(fetchOnce, intervalMs);
    return () => { alive = false; clearInterval(t); fetchRef.current = () => {}; };
  }, [sessionId, intervalMs]);
  const refresh = useCallback(() => fetchRef.current(), []);
  return [ctx, refresh];
}
