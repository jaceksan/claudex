import { useEffect, useState } from 'react';
import type { GitInfo } from '../../server/git';

export function useGitInfo(sessionId: string | undefined, intervalMs = 10_000): GitInfo | null {
  const [info, setInfo] = useState<GitInfo | null>(null);
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
    fetchOnce();
    const t = setInterval(fetchOnce, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [sessionId, intervalMs]);
  return info;
}
