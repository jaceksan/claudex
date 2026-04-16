import type { SessionStatus } from '../../server/session/state';

export const statusColors: Record<SessionStatus, string> = {
  'starting': 'bg-blue-500/20 text-blue-300 ring-blue-500/30',
  'running': 'bg-green-500/20 text-green-300 ring-green-500/30',
  'waiting-permission': 'bg-yellow-500/20 text-yellow-300 ring-yellow-500/30',
  'idle': 'bg-zinc-500/20 text-zinc-300 ring-zinc-500/30',
  'ended': 'bg-zinc-700/30 text-zinc-400 ring-zinc-600/30',
  'crashed': 'bg-red-500/20 text-red-300 ring-red-500/30',
  'detached': 'bg-purple-500/20 text-purple-300 ring-purple-500/30',
};

export const BUSY_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting-permission'];

export function isBusy(status: SessionStatus): boolean {
  return BUSY_STATUSES.includes(status);
}
