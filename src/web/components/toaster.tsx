import { useNotifications } from '../hooks/use-notifications';

const kindColors: Record<string, string> = {
  'session-ended': 'border-zinc-600',
  'tool-error': 'border-red-500/60',
  'plan-ready': 'border-purple-500/60',
  'permission-pending': 'border-yellow-500/60',
};

export function Toaster() {
  const { toasts, dismiss } = useNotifications();
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.timestamp}
          className={`pointer-events-auto rounded border bg-zinc-900/95 p-3 shadow-lg backdrop-blur ${kindColors[t.kind] ?? 'border-zinc-700'}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">{t.title}</div>
              <div className="mt-0.5 text-xs text-zinc-400">{t.body}</div>
            </div>
            <button onClick={() => dismiss(t.timestamp)} className="text-xs text-zinc-500 hover:text-zinc-200">×</button>
          </div>
        </div>
      ))}
    </div>
  );
}
