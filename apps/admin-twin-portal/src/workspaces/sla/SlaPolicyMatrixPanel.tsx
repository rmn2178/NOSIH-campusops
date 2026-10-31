import { useMemo } from 'react';
import { CalendarClock, Clock3, Info } from 'lucide-react';
import type { SlaMatrix } from '../../api/client';
import { Badge, EmptyState, ErrorBanner, Panel, cx } from '../../components/ui';
import { formatCalendarDay, formatTargetMinutes, humanise } from './slaFormat';
import { PriorityChip } from './SlaBits';

/**
 * The promise table: what every priority is answered and fixed within, and
 * the operating calendar the working-hours policies are measured against.
 */
export function SlaPolicyMatrixPanel({
  matrix,
  error,
  onRetry,
}: {
  matrix: SlaMatrix | null;
  error?: string | null;
  onRetry?: () => void;
}) {
  const nonWorkingDays = useMemo(
    () => (matrix?.calendar ?? []).filter((day) => !day.is_working_day),
    [matrix],
  );

  if (!matrix) {
    return (
      <Panel className="mb-5 overflow-hidden">
        <PanelHeader />
        {error ? (
          <div className="p-5">
            <ErrorBanner message={error} onRetry={onRetry} />
          </div>
        ) : (
          <EmptyState
            title="No policy matrix loaded"
            description="The SLA policy table could not be read from the server. Refresh to try again."
            icon={<Info className="h-5 w-5" strokeWidth={1.75}/>}
          />
        )}
      </Panel>
    );
  }

  const { policies, working_hours } = matrix;

  return (
    <Panel className="mb-5 overflow-hidden">
      <PanelHeader />
      <div className="border-b border-stitch bg-silk/40 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-stone">
          <span className="flex items-center gap-1.5">
            <Clock3 className="h-3.5 w-3.5" strokeWidth={1.75}/>
            <span className="font-medium text-obsidian">
              Desk hours {working_hours.opens_at}–{working_hours.closes_at}
            </span>
            <span>{working_hours.days}</span>
          </span>
          <span className="mono text-[10px]">{working_hours.timezone}</span>
          <span className="flex-1 text-[10px] leading-4">{working_hours.note}</span>
        </div>
        {nonWorkingDays.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-stone">
              <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75}/>
              Closed days
            </span>
            {nonWorkingDays.slice(0, 5).map((day) => (
              <span
                key={day.day_date}
                className="rounded-full border border-stitch bg-white px-2.5 py-1 text-[10px] text-obsidian"
                title={day.note ?? undefined}
              >
                {day.label ?? 'Non-working day'} · {formatCalendarDay(day.day_date)}
              </span>
            ))}
            {nonWorkingDays.length > 5 && (
              <span className="text-[10px] text-stone">+{nonWorkingDays.length - 5} more in the window</span>
            )}
          </div>
        )}
      </div>

      {policies.length === 0 ? (
        <EmptyState
          title="No active policies"
          description="Publish at least one SLA policy before requests can be measured against a promise."
        />
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-stitch text-[9px] uppercase tracking-wider text-stone">
                <th className="px-5 py-2.5 font-medium">Priority</th>
                <th className="px-3 py-2.5 font-medium">Service</th>
                <th className="px-3 py-2.5 font-medium">Response</th>
                <th className="px-3 py-2.5 font-medium">Resolution</th>
                <th className="px-3 py-2.5 font-medium">Basis</th>
                <th className="px-5 py-2.5 font-medium">Promise</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch">
              {policies.map((policy) => {
                const override = policy.category !== null;
                const cell = override ? 'py-3 pr-3 pl-6' : 'px-5 py-3';
                return (
                  <tr key={`${policy.priority_code}-${policy.category ?? 'base'}`} className="align-top">
                    <td className={cx(cell, override && 'border-l-2 border-stitch')}>
                      <div className="flex items-center gap-2">
                        <PriorityChip code={policy.priority_code} label={policy.priority_label} />
                        {!override && <span className="text-[11px] font-medium">{policy.priority_label}</span>}
                      </div>
                      {override && (
                        <span className="mt-1 block text-[9px] uppercase tracking-wider text-stone">
                          Category override · {humanise(policy.category)}
                        </span>
                      )}
                    </td>
                    <td className={cell}>
                      <p className="text-[11px] font-medium leading-4">{policy.service_name}</p>
                      {override && <p className="mt-0.5 text-[10px] text-stone">{humanise(policy.category)} only</p>}
                    </td>
                    <td className={cell}>
                      <span className="mono text-[11px]" title={`${policy.response_target_mins} target minutes`}>
                        {formatTargetMinutes(policy.response_target_mins, policy.basis)}
                      </span>
                    </td>
                    <td className={cell}>
                      <span className="mono text-[11px]" title={`${policy.resolution_target_mins} target minutes`}>
                        {formatTargetMinutes(policy.resolution_target_mins, policy.basis)}
                      </span>
                    </td>
                    <td className={cell}>
                      <Badge tone={policy.is_24x7 ? 'ink' : 'neutral'}>
                        {policy.is_24x7 ? '24×7 clock' : 'Working hours'}
                      </Badge>
                    </td>
                    <td className={cx(cell, 'pr-5')}>
                      <p className="text-[11px] leading-5 text-stone">{policy.description}</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function PanelHeader() {
  return (
    <div className="border-b border-stitch p-5">
      <h2 className="text-sm font-semibold">SLA policy matrix</h2>
      <p className="mt-1 text-[11px] text-stone">
        The promise every request is measured against — a base row per priority, with tighter category overrides beneath it.
      </p>
    </div>
  );
}
