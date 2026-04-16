import { useSessionList } from '../hooks/use-ws';

export default function DashboardPage() {
  const sessions = useSessionList();
  return (
    <div className="h-full p-6">
      {sessions.length === 0 ? (
        <div className="flex h-full items-center justify-center text-zinc-500">No sessions yet</div>
      ) : (
        <div className="text-zinc-400">{sessions.length} session(s)</div>
      )}
    </div>
  );
}
