import { useEffect, useState } from 'react';
import type { RepoRow } from '../../server/ws/topic-envelope';
import { send, subscribe } from '../lib/ws';

export function useRepos(): RepoRow[] {
  const [repos, setRepos] = useState<RepoRow[]>([]);
  useEffect(() => {
    send({ type: 'client.repo.list', payload: {} });
    const unsub = subscribe((m) => {
      if (m.type === 'server.repo.state') setRepos(m.payload.repos);
    });
    return unsub;
  }, []);
  return repos;
}
