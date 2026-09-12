import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Panel({ title, actions, children, className }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-h-0 flex-col rounded-lg border border-border bg-panel', className)}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="text-sm font-medium text-fg">{title}</h2>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  type = 'button',
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const styles: Record<string, string> = {
    default: 'border-border bg-bg hover:border-brand/60',
    primary: 'border-brand bg-brand/20 hover:bg-brand/30',
    danger: 'border-rose-500/60 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300',
    ghost: 'border-transparent hover:bg-bg',
  };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        styles[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'error' | 'info' }) {
  const tones: Record<string, string> = {
    default: 'border-border text-muted',
    ok: 'border-emerald-500/40 text-emerald-400',
    warn: 'border-amber-500/40 text-amber-400',
    error: 'border-rose-500/40 text-rose-400',
    info: 'border-brand/40 text-brand',
  };
  return <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', tones[tone])}>{children}</span>;
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg">
      <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-muted">{children}</p>;
}
