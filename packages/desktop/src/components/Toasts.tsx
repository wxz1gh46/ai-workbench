import { useAppStore } from '@/stores/app-store';
import { cn } from '@/lib/utils';

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cn(
            'pointer-events-auto rounded-md border px-3 py-2 text-left text-xs shadow-lg backdrop-blur',
            t.level === 'error' && 'border-rose-500/50 bg-rose-950/80 text-rose-200',
            t.level === 'warn' && 'border-amber-500/50 bg-amber-950/80 text-amber-200',
            t.level === 'success' && 'border-emerald-500/50 bg-emerald-950/80 text-emerald-200',
            t.level === 'info' && 'border-border bg-panel/90 text-fg',
          )}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
