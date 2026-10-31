import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { complianceTone, priorityTone, type BadgeTone } from './slaFormat';

const toneClasses: Record<BadgeTone, string> = {
  green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  red: 'border-red-200 bg-red-50 text-red-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  violet: 'border-purple-200 bg-purple-50 text-purple-800',
  cyan: 'border-cyan-200 bg-cyan-50 text-cyan-800',
  neutral: 'border-stitch bg-silk text-stone',
  ink: 'border-obsidian bg-obsidian text-white',
};

/** Compact priority marker: P1 red, P2 amber, P3 green, P4 neutral. */
export function PriorityChip({ code, label }: { code: string; label?: string }) {
  return (
    <span
      className={cx(
        'mono inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold leading-none',
        toneClasses[priorityTone(code)],
      )}
      title={label}
    >
      {code || '—'}
    </span>
  );
}

/** Horizontal compliance bar: red under 70 %, amber under 90 %, green above. */
export function ComplianceBar({ pct, className }: { pct: number; className?: string }) {
  const meta = complianceTone(pct);
  const width = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-silk', className)}>
      <div className={cx('h-full rounded-full transition-all', meta.fill)} style={{ width: `${width}%` }} />
    </div>
  );
}

/** A single figure in the compliance headline grid. */
export function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-stitch bg-linen px-3 py-2.5">
      <p className="text-[9px] uppercase tracking-wider text-stone">{label}</p>
      <p className="mono mt-1 text-base font-semibold text-obsidian">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-4 text-stone">{hint}</p>}
    </div>
  );
}
