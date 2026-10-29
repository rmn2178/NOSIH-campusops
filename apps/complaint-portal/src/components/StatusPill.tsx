import { cx } from '../lib/format';

type Tone = 'mint' | 'coral' | 'amber' | 'lavender' | 'neutral';

const tones: Record<Tone, string> = {
  mint: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  coral: 'border-red-200 bg-red-50 text-red-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  lavender: 'border-purple-200 bg-purple-50 text-purple-800',
  neutral: 'border-stitch bg-silk text-stone',
};

export function toneForStatus(value: string): Tone {
  const status = value.toUpperCase();
  if (['HEALTHY', 'RESOLVED', 'LOW', 'ON_TRACK', 'APPROVED'].includes(status)) return 'mint';
  if (['FAULTY', 'HIGH', 'CRITICAL', 'BREACHED_100'].includes(status)) return 'coral';
  if (['DEGRADED', 'MEDIUM', 'IN_PROGRESS', 'WARNING_75', 'OPEN'].includes(status)) return 'amber';
  if (status === 'BLOCKED_PARTS' || status === 'PAUSED') return 'lavender';
  return 'neutral';
}

interface StatusPillProps {
  label: string;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}

export function StatusPill({ label, tone = 'neutral', dot = false, className }: StatusPillProps) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none', tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />}
      {label}
    </span>
  );
}
