import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitInfo } from '../../server/git';

export function useGitInfo(
  sessionId: string | undefined,
  intervalMs = 10_000,
  paused = false,
): [GitInfo | null, () => void] {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const fetchRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const fetchOnce = async () => {
      try {
        const r = await fetch(`/api/sessions/${sessionId}/git`);
        if (!r.ok) return;
        const data = (await r.json()) as GitInfo;
        if (alive) setInfo(data);
      } catch {/* ignore */}
    };
    // While paused, the server must not run git probes against the worktree
    // (race with Claude's own git => stale index.lock). Skip both the initial
    // fetch and the interval, and no-op manual refreshes.
    if (paused) {
      fetchRef.current = () => {};
      return () => { alive = false; };
    }
    fetchRef.current = () => { void fetchOnce(); };
    fetchOnce();
    const t = setInterval(fetchOnce, intervalMs);
    return () => { alive = false; clearInterval(t); fetchRef.current = () => {}; };
  }, [sessionId, intervalMs, paused]);
  const refresh = useCallback(() => fetchRef.current(), []);
  return [info, refresh];
}
