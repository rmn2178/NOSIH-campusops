import { useEffect, useState } from 'react';
import { AlarmClock, CalendarClock, CheckCircle2, Clock3, PauseCircle, ShieldAlert } from 'lucide-react';
import type { SlaSnapshot } from '../api/client';
import { cx } from '../lib/format';

type SlaTone = 'healthy' | 'warning' | 'breached' | 'paused' | 'closed';

const toneStyles: Record<SlaTone, { pill: string; bar: string; dot: string; text: string }> = {
  healthy: {
    pill: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    bar: 'bg-emerald-500',
    dot: 'bg-emerald-500',
    text: 'text-emerald-800',
  },
  warning: {
    pill: 'border-amber-200 bg-amber-50 text-amber-900',
    bar: 'bg-amber-500',
    dot: 'bg-amber-500',
    text: 'text-amber-900',
  },
  breached: {
    pill: 'border-red-200 bg-red-50 text-red-800',
    bar: 'bg-red-500',
    dot: 'bg-red-500',
    text: 'text-red-800',
  },
  paused: {
    pill: 'border-purple-200 bg-purple-50 text-purple-800',
    bar: 'bg-purple-400',
    dot: 'bg-purple-400',
    text: 'text-purple-800',
  },
  closed: {
    pill: 'border-stitch bg-silk text-stone',
    bar: 'bg-stitch',
    dot: 'bg-stone',
    text: 'text-stone',
  },
};

const priorityTone: Record<string, SlaTone> = {
  P1: 'breached',
  P2: 'warning',
  P3: 'healthy',
  P4: 'closed',
};

export function slaTone(sla: SlaSnapshot | null | undefined): SlaTone {
  if (!sla || !sla.available) return 'closed';
  if (sla.state === 'CLOSED') return 'closed';
  if (sla.state === 'PAUSED') return 'paused';
  if (sla.state === 'BREACHED') return 'breached';
  if (sla.state === 'WARNING') return 'warning';
  return 'healthy';
}

/** A ticking clock so a countdown never looks frozen. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Minutes left before the deadline, counting down live. */
function remainingMinutes(sla: SlaSnapshot, now: number): number {
  if (!sla.due_at) return sla.resolution_remaining_mins;
  const due = new Date(sla.due_at).getTime();
  if (Number.isNaN(due)) return sla.resolution_remaining_mins;
  return Math.max(0, Math.round((due - now) / 60_000));
}

export function formatMinutes(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  if (safe >= 24 * 60) {
    const days = Math.floor(safe / (24 * 60));
    const hours = Math.round((safe % (24 * 60)) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (safe >= 60) {
    const hours = Math.floor(safe / 60);
    const rest = safe % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${safe}m`;
}

interface SlaBadgeProps {
  sla?: SlaSnapshot | null;
  className?: string;
  showPriority?: boolean;
}

/** The compact SLA badge: colour-coded state and a live countdown. */
export function SlaBadge({ sla, className, showPriority = true }: SlaBadgeProps) {
  const now = useNow();
  if (!sla || !sla.available) return null;

  const tone = slaTone(sla);
  const styles = toneStyles[tone];
  const remaining = remainingMinutes(sla, now);

  const label =
    tone === 'closed'
      ? 'SLA closed'
      : tone === 'paused'
        ? 'SLA paused'
        : tone === 'breached'
          ? 'SLA breached'
          : `${formatMinutes(remaining)} left`;

  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-semibold leading-none',
        styles.pill,
        className,
      )}
      title={
        sla.priority_label
          ? `${sla.priority_code} ${sla.priority_label} · ${sla.service_name ?? ''}`.trim()
          : undefined
      }
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', styles.dot)} aria-hidden="true" />
      {showPriority && sla.priority_code && <span className="mono">{sla.priority_code}</span>}
      {label}
    </span>
  );
}

interface SlaMeterProps {
  label: string;
  targetMinutes: number;
  elapsedMinutes: number;
  percent: number;
  tone: SlaTone;
  stateLabel: string;
  detail?: string;
}

/** One promise: its deadline, how much of it is spent, and the bar. */
function SlaMeter({ label, targetMinutes, elapsedMinutes, percent, tone, stateLabel, detail }: SlaMeterProps) {
  const styles = toneStyles[tone];
  const width = Math.max(2, Math.min(100, percent));

  return (
    <div className="rounded-xl border border-stitch bg-silk/50 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-stone">{label}</p>
        <span className={cx('mono text-[11px] font-semibold', styles.text)}>{stateLabel}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white">
        <div className={cx('h-full rounded-full transition-all', styles.bar)} style={{ width: `${width}%` }} />
      </div>
      <p className="mono mt-2 text-[10px] text-stone">
        {formatMinutes(elapsedMinutes)} of {formatMinutes(targetMinutes)} used
        {detail ? <span className="opacity-70"> · {detail}</span> : null}
      </p>
    </div>
  );
}

interface SlaPanelProps {
  sla?: SlaSnapshot | null;
  className?: string;
}

/** The full SLA panel: both deadlines, the milestone track and the policy. */
export function SlaPanel({ sla, className }: SlaPanelProps) {
  const now = useNow();
  if (!sla || !sla.available) {
    return (
      <section className={cx('cloth-card p-5', className)} aria-label="Service level agreement">
        <p className="eyebrow">Service level agreement</p>
        <p className="mt-3 text-sm text-stone">This request carries no SLA clock.</p>
      </section>
    );
  }

  const tone = slaTone(sla);
  const remaining = remainingMinutes(sla, now);
  const basis = sla.is_24x7 ? '24×7 clock' : 'working hours only';

  return (
    <section className={cx('cloth-card p-5 sm:p-6', className)} aria-label="Service level agreement">
      <div className="flex flex-wrap items-center gap-2">
        <p className="eyebrow">Service level agreement</p>
        {sla.priority_code && (
          <span
            className={cx(
              'mono inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold',
              toneStyles[priorityTone[sla.priority_code] ?? 'closed'].pill,
            )}
          >
            {sla.priority_code}
            {sla.priority_label ? ` · ${sla.priority_label}` : ''}
          </span>
        )}
        {sla.service_name && (
          <span className="rounded-full border border-stitch bg-silk px-2.5 py-1 text-[10px] font-medium text-stone">
            {sla.service_name}
          </span>
        )}
        <span className="ml-auto"><SlaBadge sla={sla} showPriority={false} /></span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SlaMeter
          label="Response"
          targetMinutes={sla.response_target_mins}
          elapsedMinutes={sla.response_elapsed_mins}
          percent={sla.response_progress_pct}
          tone={
            sla.response_state === 'MET'
              ? 'healthy'
              : sla.response_state === 'BREACHED'
                ? 'breached'
                : sla.response_state === 'WARNING'
                  ? 'warning'
                  : 'healthy'
          }
          stateLabel={
            sla.response_state === 'MET'
              ? 'Answered'
              : sla.response_state === 'BREACHED'
                ? 'Answer missed'
                : sla.response_state === 'WARNING'
                  ? 'Due soon'
                  : 'Awaiting reply'
          }
          detail={sla.first_response_at ? 'answered' : 'no reply yet'}
        />
        <SlaMeter
          label="Resolution"
          targetMinutes={sla.resolution_target_mins}
          elapsedMinutes={sla.resolution_elapsed_mins}
          percent={sla.resolution_progress_pct}
          tone={tone}
          stateLabel={
            tone === 'closed'
              ? 'Delivered'
              : tone === 'paused'
                ? 'Paused'
                : tone === 'breached'
                  ? 'Overdue'
                  : `${formatMinutes(remaining)} left`
          }
          detail={basis}
        />
      </div>

      <div className="mt-5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-stone">Milestones</p>
        <ol className="mt-3 flex items-start">
          {sla.milestones.map((milestone, index) => {
            const milestoneTone = milestone.breached ? 'breached' : milestone.reached ? 'healthy' : 'closed';
            const stylesForMilestone = toneStyles[milestoneTone];
            const last = index === sla.milestones.length - 1;
            return (
              <li key={milestone.key} className="flex min-w-0 flex-1 flex-col items-center text-center">
                <div className="flex w-full items-center">
                  <span className={cx('h-px flex-1', index === 0 ? 'bg-transparent' : milestone.reached ? stylesForMilestone.bar : 'bg-stitch')} />
                  <span
                    className={cx(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
                      milestone.breached
                        ? 'border-red-200 bg-red-50 text-red-700'
                        : milestone.reached
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-stitch bg-white text-stone',
                    )}
                  >
                    {milestone.breached ? (
                      <ShieldAlert size={12} strokeWidth={1.75} />
                    ) : milestone.reached ? (
                      <CheckCircle2 size={12} strokeWidth={1.75} />
                    ) : (
                      <span className="mono text-[8px]">{index + 1}</span>
                    )}
                  </span>
                  <span className={cx('h-px flex-1', last ? 'bg-transparent' : milestone.reached ? stylesForMilestone.bar : 'bg-stitch')} />
                </div>
                <span className="mt-2 text-[9px] leading-tight text-stone">{milestone.label}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <dl className="mt-5 grid gap-x-4 gap-y-2 border-t border-stitch pt-4 text-[11px] sm:grid-cols-2">
        {sla.work_order_number && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-stone">Work order</dt>
            <dd className="mono font-semibold">{sla.work_order_number}</dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-stone">Escalation tier</dt>
          <dd className="mono font-semibold">{sla.escalation_tier} / 4</dd>
        </div>
        {sla.pause_reason && (
          <div className="flex items-center justify-between gap-2 sm:col-span-2">
            <dt className="text-stone">Clock paused</dt>
            <dd className="flex items-center gap-1.5 font-semibold text-purple-800">
              <PauseCircle size={12} strokeWidth={1.75} />
              {sla.pause_reason.replaceAll('_', ' ').toLowerCase()}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 sm:col-span-2">
          <dt className="text-stone">Basis</dt>
          <dd className="flex items-center gap-1.5 font-semibold">
            {sla.is_24x7 ? <AlarmClock size={12} strokeWidth={1.75} /> : <CalendarClock size={12} strokeWidth={1.75} />}
            {basis}
          </dd>
        </div>
      </dl>

      {sla.policy_note && (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-stitch bg-silk/60 px-3 py-2.5 text-[11px] leading-5 text-stone">
          <Clock3 size={13} className="mt-0.5 shrink-0" />
          {sla.policy_note}
        </p>
      )}
    </section>
  );
}
