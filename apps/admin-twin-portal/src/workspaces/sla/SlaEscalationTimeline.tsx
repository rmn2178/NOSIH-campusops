import { useState } from 'react';
import { ArrowUp, Bell, Check, Pause, Play } from 'lucide-react';
import type { SlaBoardRow } from '../../api/client';
import type { NotificationLog } from '../../types';
import { Badge, Button, EmptyState, Panel, cx, formatDate } from '../../components/ui';
import {
  ESCALATION_TIERS,
  PAUSE_REASONS,
  formatDuration,
  humanise,
  notificationTargetsWorkOrder,
  stateMeta,
  type PauseReason,
} from './slaFormat';

interface Props {
  row: SlaBoardRow | null;
  notifications: NotificationLog[];
  canControl: boolean;
  actionError: string | null;
  actionPending: boolean;
  onPause: (reason: PauseReason) => void;
  onResume: () => void;
}

/**
 * The escalation record for one clock: the four-tier ladder, the milestone
 * track, the operational facts and every outbound notification raised for
 * that work order.
 */
export function SlaEscalationTimeline({
  row,
  notifications,
  canControl,
  actionError,
  actionPending,
  onPause,
  onResume,
}: Props) {
  const [reason, setReason] = useState<PauseReason>(PAUSE_REASONS[0].value);

  if (!row) {
    return (
      <Panel className="overflow-hidden">
        <div className="border-b border-stitch p-5">
          <h2 className="text-sm font-semibold">Escalation record</h2>
          <p className="mt-1 text-[11px] text-stone">Select a clock to inspect its escalation chain.</p>
        </div>
        <EmptyState
          title="No clock selected"
          description="Pick a live clock from the list to see who owns it, which milestones it passed and what was sent out."
        />
      </Panel>
    );
  }

  const state = stateMeta(row.state);
  const tier = Math.max(0, Math.min(ESCALATION_TIERS.length, row.escalation_tier));
  const milestones = [
    {
      key: 'RESPONSE',
      label: 'Reporter answered',
      reached: row.response_state === 'MET',
      breached: row.response_state === 'BREACHED',
      detail: `${row.response_elapsed_mins} of ${row.response_target_mins} min`,
    },
    {
      key: 'HALF_ELAPSED',
      label: 'Half elapsed',
      reached: row.resolution_progress_pct >= 50,
      breached: false,
      detail: `${Math.round(row.resolution_target_mins * 0.5)} min`,
    },
    {
      key: 'WARNING_75',
      label: '75% warning',
      reached: row.resolution_progress_pct >= 75,
      breached: false,
      detail: `${Math.round(row.resolution_target_mins * 0.75)} min`,
    },
    {
      key: 'BREACHED_100',
      label: 'Resolution deadline',
      reached: row.resolution_progress_pct >= 100,
      breached: row.breach_state === 'BREACHED_100',
      detail: `${row.resolution_target_mins} min`,
    },
  ];
  const related = notifications.filter((notification) =>
    notificationTargetsWorkOrder(notification.payload, row.work_order_id),
  );

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stitch p-5">
        <div>
          <p className="text-[9px] uppercase tracking-wider text-stone">Escalation record</p>
          <h2 className="mono mt-1 text-sm font-semibold">{row.work_order_number || `#${row.work_order_id}`}</h2>
          <p className="mt-1 text-[10px] text-stone">
            {row.ticket_number ? `${row.ticket_number} · ` : ''}{row.space_code} · {row.service_name}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={state.tone} dot>{state.label}</Badge>
          <Badge tone="neutral">Tier {tier} / {ESCALATION_TIERS.length}</Badge>
        </div>
      </div>

      <div className="space-y-5 p-5">
        {canControl && (
          <div className="rounded-lg border border-stitch bg-linen p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-stone">Clock controls</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <select
                value={reason}
                onChange={(event) => setReason(event.target.value as PauseReason)}
                aria-label="Pause reason"
                className="h-8 rounded-lg border border-stitch bg-white px-2 text-[11px] outline-none focus:border-[#c9c6bd]"
              >
                {PAUSE_REASONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <Button size="sm" variant="secondary" disabled={actionPending || row.state === 'PAUSED' || row.state === 'CLOSED'} onClick={() => onPause(reason)}>
                <Pause className="h-3.5 w-3.5" strokeWidth={1.75}/>
                {actionPending ? 'Working…' : 'Pause clock'}
              </Button>
              <Button size="sm" variant="secondary" disabled={actionPending || row.state !== 'PAUSED'} onClick={onResume}>
                <Play className="h-3.5 w-3.5" strokeWidth={1.75}/>
                Resume
              </Button>
            </div>
            {actionError && (
              <p className="mt-2 text-[10px] leading-4 text-red-700" role="alert">{actionError}</p>
            )}
            {row.state === 'PAUSED' && (
              <p className="mt-2 text-[10px] text-stone">
                Stopped with <span className="font-medium">{humanise(row.pause_reason)}</span> — the deadline is frozen until it resumes.
              </p>
            )}
          </div>
        )}

        <div>
          <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-stone">Escalation ladder</h3>
          <div className="space-y-0">
            {ESCALATION_TIERS.map((name, index) => {
              const reached = tier >= index + 1;
              const owner = index === tier - 1 && row.state !== 'CLOSED';
              return (
                <div key={name} className="relative flex gap-3 pb-5 last:pb-0">
                  {index < ESCALATION_TIERS.length - 1 && (
                    <div className={cx('absolute left-[11px] top-6 h-full w-px', reached ? 'bg-obsidian' : 'bg-stitch')} />
                  )}
                  <span
                    className={cx(
                      'relative z-10 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border bg-white',
                      reached ? 'border-obsidian text-obsidian' : 'border-stitch text-stone',
                    )}
                  >
                    {reached ? <ArrowUp className="h-3 w-3" strokeWidth={1.75}/> : <span className="mono text-[8px]">{index + 1}</span>}
                  </span>
                  <div>
                    <p className={cx('text-xs font-medium', !reached && 'text-stone')}>
                      Tier {index + 1} · {name}
                    </p>
                    <p className="mt-1 text-[10px] text-stone">
                      {reached
                        ? owner
                          ? 'Currently holding this request'
                          : 'Notification threshold reached'
                        : 'Awaiting escalation threshold'}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="border-t border-stitch pt-4">
          <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-stone">Milestone track</h3>
          <ol className="flex items-start">
            {milestones.map((milestone, index) => (
              <li key={milestone.key} className="flex flex-1 flex-col items-center text-center">
                <div className="flex w-full items-center">
                  {index > 0 && <span className={cx('h-px flex-1', milestone.reached ? 'bg-obsidian' : 'bg-stitch')} />}
                  <span
                    className={cx(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                      milestone.breached
                        ? 'border-red-300 bg-red-50 text-red-700'
                        : milestone.reached
                          ? 'border-obsidian bg-obsidian text-white'
                          : 'border-stitch bg-white text-stone',
                    )}
                  >
                    {milestone.breached ? (
                      <span className="mono text-[9px]">!</span>
                    ) : milestone.reached ? (
                      <Check className="h-3 w-3" strokeWidth={1.75}/>
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-stitch" />
                    )}
                  </span>
                  {index < milestones.length - 1 && (
                    <span className={cx('h-px flex-1', milestones[index + 1].reached ? 'bg-obsidian' : 'bg-stitch')} />
                  )}
                </div>
                <p className={cx('mt-2 text-[9px] font-medium leading-3', milestone.reached ? 'text-obsidian' : 'text-stone')}>
                  {milestone.label}
                </p>
                <p className="mono mt-1 text-[9px] text-stone">{milestone.detail}</p>
                {milestone.breached && <span className="mt-1 text-[9px] font-semibold text-red-700">Breached</span>}
              </li>
            ))}
          </ol>
        </div>

        <dl className="grid grid-cols-2 gap-2 border-t border-stitch pt-4 text-[10px]">
          <Fact label="Paused because" value={row.pause_reason ? humanise(row.pause_reason) : 'Not paused'} />
          <Fact label="Escalated at" value={row.escalated_at ? formatDate(row.escalated_at) : 'Not escalated'} />
          <Fact label="Officer" value={row.officer ? `${row.officer.full_name} (${row.officer.staff_code})` : 'Unassigned'} />
          <Fact label="Officer mail" value={row.officer_email ?? '—'} />
          <Fact label="Head of department" value={row.head_of_department ?? '—'} />
          <Fact label="Work order" value={row.work_order_status ?? '—'} />
          <Fact
            label="Active time"
            value={`${row.resolution_elapsed_mins} of ${row.resolution_target_mins} min (${formatDuration(row.resolution_elapsed_mins)})`}
          />
          <Fact
            label="Closed"
            value={row.closed_at ? `${formatDate(row.closed_at)}${row.closed_reason ? ` · ${humanise(row.closed_reason)}` : ''}` : 'Still open'}
          />
        </dl>

        {row.policy_note && (
          <p className="rounded-lg bg-silk p-3 text-[10px] leading-5 text-stone">
            <span className="font-semibold text-obsidian">Policy · </span>
            {row.policy_note}
          </p>
        )}

        <div className="border-t border-stitch pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone">Outbound notifications</h3>
            <Badge tone="neutral">{related.length}</Badge>
          </div>
          {related.length === 0 ? (
            <p className="text-[10px] leading-5 text-stone">
              No escalation mail has been sent for this work order yet.
            </p>
          ) : (
            <div className="space-y-2">
              {related.map((notification) => (
                <div key={notification.id} className="rounded-lg bg-silk p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
                    <span className="flex items-center gap-1.5">
                      <Bell className="h-3 w-3 text-stone" strokeWidth={1.75}/>
                      <span className="font-medium">{notification.channel}</span>
                      <span className="text-stone">{notification.recipient}</span>
                    </span>
                    <span className="text-stone">{formatDate(notification.created_at)}</span>
                  </div>
                  <p className="mt-1.5 text-[10px] leading-4">{notification.subject ?? 'SLA notification'}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stitch bg-linen px-3 py-2">
      <dt className="text-[9px] uppercase tracking-wider text-stone">{label}</dt>
      <dd className="mt-1 break-words text-[10px] leading-4">{value}</dd>
    </div>
  );
}
