import { useEffect, useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, Check, Inbox, LoaderCircle, X } from 'lucide-react';

export const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

export function Button({ className, variant = 'primary', size = 'md', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'icon';
}) {
  return (
    <button
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium transition-all disabled:cursor-not-allowed disabled:opacity-45',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2',
        size === 'sm' && 'h-8 px-3 text-xs',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'icon' && 'h-9 w-9',
        variant === 'primary' && 'bg-obsidian text-white shadow-sm hover:bg-[#30302d] active:translate-y-px',
        variant === 'secondary' && 'border border-stitch bg-white text-obsidian shadow-sm hover:border-[#c9c6bd] hover:bg-[#fcfbf8]',
        variant === 'ghost' && 'text-stone hover:bg-black/[.045] hover:text-obsidian',
        variant === 'danger' && 'border border-red-200 bg-red-50 text-red-800 hover:bg-red-100',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Panel({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded-xl border border-stitch bg-white shadow-cloth', className)} {...props}>{children}</div>;
}

const tones = {
  green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  red: 'border-red-200 bg-red-50 text-red-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  violet: 'border-purple-200 bg-purple-50 text-purple-800',
  cyan: 'border-cyan-200 bg-cyan-50 text-cyan-800',
  neutral: 'border-stitch bg-silk text-stone',
  ink: 'border-obsidian bg-obsidian text-white',
};

export function Badge({ children, tone = 'neutral', className, dot = false }: {
  children: ReactNode;
  tone?: keyof typeof tones;
  className?: string;
  dot?: boolean;
}) {
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase leading-none tracking-[.08em]', tones[tone], className)}>
    {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}{children}
  </span>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status.includes('FAULT') || status.includes('BREACH') || status.includes('REJECT') || status === 'CRITICAL'
    ? 'red'
    : status.includes('BLOCK') || status.includes('OVERRIDE')
      ? 'violet'
      : status.includes('DEGRADED') || status.includes('WARNING') || status === 'HIGH' || status === 'PENDING_APPROVAL'
        ? 'amber'
        : status.includes('HEALTHY') || status.includes('RESOLVED') || status.includes('APPROVED') || status === 'ALLOWED'
          ? 'green'
          : 'neutral';
  return <Badge tone={tone} dot>{status.replaceAll('_', ' ')}</Badge>;
}

export function Spinner({ label = 'Loading live data' }: { label?: string }) {
  return <div className="flex items-center justify-center gap-3 py-16 text-sm text-stone" role="status">
    <LoaderCircle className="h-4 w-4 animate-spin" />{label}
  </div>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
    <div className="min-w-0 flex-1"><p className="font-medium">The operation could not be completed</p><p className="mt-1 break-words text-red-800">{message}</p></div>
    {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
  </div>;
}

export function EmptyState({ title, description, icon }: { title: string; description: string; icon?: ReactNode }) {
  return <div className="flex min-h-44 flex-col items-center justify-center px-6 py-10 text-center">
    <div className="mb-3 rounded-full border border-stitch bg-silk p-3 text-stone">{icon ?? <Inbox className="h-5 w-5" />}</div>
    <p className="text-sm font-medium">{title}</p><p className="mt-1 max-w-sm text-xs leading-5 text-stone">{description}</p>
  </div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
    <div><p className="mb-2 text-[10px] font-semibold uppercase tracking-[.2em] text-stone">{eyebrow}</p>
      <h1 className="text-balance text-2xl font-semibold tracking-[-.035em] text-obsidian sm:text-3xl">{title}</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-stone">{description}</p></div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </div>;
}

export function Modal({ open, onClose, title, description, children, wide = false }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1c1c19]/25 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx('flex max-h-[92vh] w-full animate-slide-in flex-col overflow-hidden rounded-2xl border border-white/60 bg-linen shadow-float', wide ? 'max-w-7xl' : 'max-w-xl')}>
      <header className="flex items-start justify-between border-b border-stitch bg-white/70 px-5 py-4 sm:px-6">
        <div><h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>{description && <p className="mt-1 text-xs leading-5 text-stone">{description}</p>}</div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog"><X className="h-4 w-4" /></Button>
      </header>
      <div className="scrollbar-thin overflow-y-auto p-5 sm:p-6">{children}</div>
    </section>
  </div>;
}

export function CheckItem({ passed, label, detail }: { passed: boolean; label: string; detail: string }) {
  return <div className="flex gap-2.5 rounded-lg border border-stitch bg-white p-3">
    <span className={cx('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full', passed ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')}>
      {passed ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
    </span><div><p className="text-xs font-medium">{label.replaceAll('_', ' ')}</p><p className="mt-0.5 text-[11px] leading-4 text-stone">{detail}</p></div>
  </div>;
}

export const formatDate = (value?: string) => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
export const formatINR = (value: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);

const assetTypeShort: Record<string, string> = {
  CEILING_FAN: 'Fan',
  LED_LIGHT: 'Light',
  SMART_BOARD: 'Board',
  LAB_WORKSTATION: 'PC',
  CANTEEN_APPLIANCE: 'Appliance',
  BILL_BOT_MECHANISM: 'Bot',
};

/** Asset codes share a room prefix, so the last two segments collide across
 * asset types; show the type and slot instead of a repeated "03-01". */
export const assetShortLabel = (asset: { asset_type: string; asset_code: string; slot_index?: number | null }) => {
  const label = assetTypeShort[asset.asset_type]
    ?? asset.asset_type.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  const slot = asset.slot_index ?? Number(asset.asset_code.split('-').pop());
  return Number.isFinite(slot) ? `${label} ${String(slot).padStart(2, '0')}` : label;
};
