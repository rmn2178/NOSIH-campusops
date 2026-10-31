import { BellRing, Clock3, Pause, UserRound } from 'lucide-react';
import type { SlaBoardRow, SlaBoardSummary } from '../../api/client';
import { Badge, EmptyState, Panel, Spinner, cx } from '../../components/ui';
import {
  formatCountdown,
  formatDuration,
  formatTargetMinutes,
  humanise,
  isOverdue,
  remainingSeconds,
  responseMeta,
  stateMeta,
} from './slaFormat';
import { PriorityChip } from './SlaBits';

const FILTERS = ['ALL', 'HEALTHY', 'WARNING', 'BREACHED', 'PAUSED', 'CLOSED'] as const;

interface Props {
  rows: SlaBoardRow[];
  summary: SlaBoardSummary;
  filter: string;
  onFilterChange: (filter: string) => void;
  selectedId: number | null;
  onSelect: (workOrderId: number) => void;
  loadedAt: number;
  now: number;
  loading: boolean;
}

/** Every live clock, coloured by state, with a countdown that keeps moving. */
export function SlaClockList({
  rows,
  summary,
  filter,
  onFilterChange,
  selectedId,
  onSelect,
  loadedAt,
  now,
  loading,
}: Props) {
  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stitch p-5">
        <div>
          <h2 className="text-sm font-semibold">Live clocks</h2>
          <p className="mt-1 text-[11px] text-stone">
            One row per campus request. The countdown runs on the server clock and ticks here every 30 seconds.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="green">{summary.healthy} healthy</Badge>
          <Badge tone="amber">{summary.warning} warning</Badge>
          <Badge tone="red">{summary.breached} breached</Badge>
          <Badge tone="violet">{summary.paused} paused</Badge>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-stitch bg-silk/40 px-5 py-2.5">
        {FILTERS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onFilterChange(item)}
            className={cx(
              'rounded-lg px-3 py-1.5 text-[10px] font-medium transition',
              filter === item ? 'bg-obsidian text-white' : 'border border-stitch bg-white text-stone hover:border-[#c9c6bd]',
            )}
          >
            {item === 'ALL' ? 'All clocks' : item.charAt(0) + item.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {loading && rows.length === 0 ? (
        <Spinner label="Loading SLA clocks" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No clocks match this filter"
          description="Choose another state, or wait for operational work to begin on campus."
        />
      ) : (
        <div className="scrollbar-thin max-h-[760px] divide-y divide-stitch overflow-y-auto">
          {rows.map((row) => (
            <ClockRow
              key={row.clock_id}
              row={row}
              selected={row.work_order_id === selectedId}
              onSelect={onSelect}
              loadedAt={loadedAt}
              now={now}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function ClockRow({
  row,
  selected,
  onSelect,
  loadedAt,
  now,
}: {
  row: SlaBoardRow;
  selected: boolean;
  onSelect: (workOrderId: number) => void;
  loadedAt: number;
  now: number;
}) {
  const state = stateMeta(row.state);
  const response = responseMeta(row.response_state);
  const overdue = isOverdue(row);
  const remaining = remainingSeconds(row, loadedAt, now);
  const overdueBy = Math.max(0, Math.round(row.resolution_elapsed_mins - row.resolution_target_mins));
  const officer = row.officer;

  return (
    <button
      type="button"
      onClick={() => onSelect(row.work_order_id)}
      className={cx(
        'block w-full px-5 py-4 text-left transition',
        selected ? 'bg-linen' : 'bg-white hover:bg-linen/50',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-xs font-semibold">{row.work_order_number || `#${row.work_order_id}`}</span>
            {row.ticket_number && <span className="mono text-[10px] text-stone">{row.ticket_number}</span>}
            <span className="mono text-[10px] text-stone">{row.space_code}</span>
            <PriorityChip code={row.priority_code} label={row.priority_label} />
          </div>
          <p className="mt-1 truncate text-[11px] text-stone">{row.title ?? row.service_name}</p>
        </div>
        <Badge tone={state.tone} dot>{state.label}</Badge>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-stone">
        <span className="truncate">{row.service_name}</span>
        <span className="flex items-center gap-1">
          <UserRound className="h-3 w-3" strokeWidth={1.75}/>
          {officer ? `${officer.full_name} · ${humanise(officer.primary_skill)}` : 'unassigned'}
        </span>
        <span className="flex items-center gap-1">
          <Clock3 className="h-3 w-3" strokeWidth={1.75}/>
          {row.department_code}
        </span>
        {row.state === 'PAUSED' && (
          <span className="flex items-center gap-1 text-purple-700">
            <Pause className="h-3 w-3" strokeWidth={1.75}/>
            {humanise(row.pause_reason)}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className={cx('mono text-xl font-semibold', overdue ? 'text-red-700' : state.text)}>
            {row.state === 'PAUSED'
              ? 'Paused'
              : overdue
                ? 'Overdue'
                : formatCountdown(remaining)}
          </p>
          <p className="mt-0.5 text-[9px] uppercase tracking-wider text-stone">
            {row.state === 'PAUSED'
              ? 'Clock stopped — the deadline is not running'
              : overdue
                ? overdueBy > 0
                  ? `Past the ${formatTargetMinutes(row.resolution_target_mins, row.basis)} deadline by ${formatDuration(overdueBy)}`
                  : `Past the ${formatTargetMinutes(row.resolution_target_mins, row.basis)} deadline`
                : `${row.basis === 'CLOCK' ? 'Wall clock' : 'Working hours'} left to resolve`}
          </p>
        </div>
        <div className="text-right">
          <p className="mono text-xs font-medium">{Math.round(row.resolution_progress_pct)}%</p>
          <p className="text-[9px] uppercase tracking-wider text-stone">of target used</p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="h-2 overflow-hidden rounded-full bg-silk">
          <div
            className={cx('h-full rounded-full transition-all', state.fill)}
            style={{ width: `${Math.min(100, Math.max(0, row.resolution_progress_pct))}%` }}
          />
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-silk">
          <div
            className={cx('h-full rounded-full transition-all', response.fill)}
            style={{ width: `${Math.min(100, Math.max(0, row.response_progress_pct))}%` }}
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[9px] text-stone">
        <span className="flex items-center gap-1">
          <BellRing className="h-3 w-3" strokeWidth={1.75}/>
          {response.label} · {row.response_elapsed_mins} / {row.response_target_mins} min
        </span>
        <span className="mono">
          {row.resolution_elapsed_mins} / {row.resolution_target_mins} active min · tier {row.escalation_tier}
        </span>
      </div>
    </button>
  );
}
