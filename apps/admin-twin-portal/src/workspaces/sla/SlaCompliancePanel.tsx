import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3 } from 'lucide-react';
import type { SlaComplianceReport } from '../../api/client';
import { Badge, EmptyState, ErrorBanner, Panel, Spinner, cx } from '../../components/ui';
import { complianceTone, formatDuration, humanise, priorityFill } from './slaFormat';
import { ComplianceBar, Figure } from './SlaBits';

const WINDOWS = [30, 90, 180] as const;

interface Props {
  report: SlaComplianceReport | null;
  days: number;
  onDaysChange: (days: number) => void;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/**
 * How the desk performed over the chosen window: the headline figures, the
 * compliance bar per department, and the priority and service breakdowns.
 */
export function SlaCompliancePanel({ report, days, onDaysChange, loading, error, onRetry }: Props) {
  const priorityData = useMemo(
    () =>
      (report?.by_priority ?? []).map((row) => ({
        name: row.priority_code,
        requests: row.requests,
        met: row.met,
        breached: row.breached,
        compliance: row.compliance_pct,
      })),
    [report],
  );

  return (
    <Panel className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stitch p-5">
        <div>
          <h2 className="text-sm font-semibold">SLA compliance</h2>
          <p className="mt-1 text-[11px] text-stone">
            {report ? `${report.window_basis} over the last ${report.window_days} days.` : 'Loading the compliance window.'}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-stitch bg-silk p-1">
          {WINDOWS.map((window) => (
            <button
              key={window}
              type="button"
              onClick={() => onDaysChange(window)}
              className={cx(
                'rounded-md px-2.5 py-1.5 text-[10px] font-medium transition',
                days === window ? 'bg-obsidian text-white' : 'text-stone hover:text-obsidian',
              )}
            >
              {window}d
            </button>
          ))}
        </div>
      </div>

      {!report ? (
        error ? (
          <div className="p-5">
            <ErrorBanner message={error} onRetry={onRetry} />
          </div>
        ) : loading ? (
          <Spinner label="Computing SLA compliance" />
        ) : (
          <EmptyState title="No compliance data" description="The compliance window could not be read from the server." />
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 border-b border-stitch bg-silk/30 p-5 sm:grid-cols-4 xl:grid-cols-8">
            <Figure label="Requests" value={report.totals.requests} hint="Raised in window" />
            <Figure label="Closed" value={report.totals.closed} hint={`${report.totals.open} still open`} />
            <Figure label="Met" value={report.totals.met} hint="Inside the deadline" />
            <Figure label="Missed" value={report.totals.missed} hint="Resolved late" />
            <Figure label="Open" value={report.totals.open} hint={`${report.totals.open_breached} already breached`} />
            <Figure
              label="Compliance"
              value={`${report.totals.compliance_pct}%`}
              hint="Met ÷ closed"
            />
            <Figure label="Avg resolution" value={formatDuration(report.totals.avg_resolution_mins)} hint="Closed requests" />
            <Figure
              label="Response rate"
              value={`${report.totals.response_compliance_pct}%`}
              hint={`${report.totals.responded} answered · ${report.totals.response_missed} closed unanswered`}
            />
          </div>

          <div className="grid items-start gap-5 p-5 xl:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold">Compliance by department</h3>
                <Badge tone="neutral">{report.by_department.length} departments</Badge>
              </div>
              {report.by_department.length === 0 ? (
                <EmptyState title="No departmental requests" description="No request was raised in this window." />
              ) : (
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full min-w-[520px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-stitch text-[9px] uppercase tracking-wider text-stone">
                        <th className="py-2 pr-3 font-medium">Department</th>
                        <th className="py-2 pr-3 font-medium">Requests</th>
                        <th className="py-2 pr-3 font-medium">Met</th>
                        <th className="py-2 pr-3 font-medium">Avg</th>
                        <th className="py-2 font-medium">Compliance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stitch">
                      {report.by_department.map((department) => {
                        const meta = complianceTone(department.compliance_pct);
                        return (
                          <tr key={department.department_code}>
                            <td className="py-2.5 pr-3">
                              <p className="mono text-[11px] font-medium">{department.department_code}</p>
                              <p className="mt-0.5 text-[9px] leading-4 text-stone">
                                {department.services.length > 0 ? department.services.map(humanise).join(' · ') : 'Campus-wide'}
                              </p>
                            </td>
                            <td className="py-2.5 pr-3">
                              <span className="mono text-[11px]">{department.requests}</span>
                              <span className="ml-1 text-[9px] text-stone">({department.open} open)</span>
                            </td>
                            <td className="py-2.5 pr-3">
                              <span className="mono text-[11px]">{department.met}</span>
                              <span className="ml-1 text-[9px] text-stone">of {department.closed}</span>
                            </td>
                            <td className="py-2.5 pr-3">
                              <span className="mono text-[10px] text-stone">{formatDuration(department.avg_resolution_mins)}</span>
                            </td>
                            <td className="py-2.5">
                              <div className="flex items-center gap-2">
                                <ComplianceBar pct={department.compliance_pct} className="w-24" />
                                <span className={cx('mono text-[11px] font-medium', meta.text)}>
                                  {department.compliance_pct}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold">Requests by priority</h3>
                <Badge tone="neutral">Coloured by priority band</Badge>
              </div>
              {priorityData.length === 0 ? (
                <EmptyState title="No priority data" description="No request was raised in this window." />
              ) : (
                <>
                  <div className="h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={priorityData} margin={{ left: -20, right: 8, top: 8, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="#ECE9E2" />
                        <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip
                          contentStyle={{ borderRadius: 10, border: '1px solid #E6E4DC', fontSize: 11 }}
                          cursor={{ fill: 'rgba(20,20,19,.04)' }}
                        />
                        <Bar dataKey="requests" radius={[4, 4, 0, 0]} maxBarSize={48}>
                          {priorityData.map((entry) => (
                            <Cell key={entry.name} fill={priorityFill(entry.name)} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {report.by_priority.map((row) => {
                      const meta = complianceTone(row.compliance_pct);
                      return (
                        <div key={row.priority_code} className="rounded-lg border border-stitch bg-linen px-2.5 py-2">
                          <div className="flex items-center justify-between">
                            <span className="mono text-[10px] font-semibold">{row.priority_code}</span>
                            <span className={cx('mono text-[10px] font-medium', meta.text)}>{row.compliance_pct}%</span>
                          </div>
                          <p className="mt-1 text-[9px] text-stone">
                            {row.met} met · {row.breached} breached
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="border-t border-stitch p-5">
            <div className="mb-3 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-stone" strokeWidth={1.75}/>
              <h3 className="text-xs font-semibold">Compliance by service</h3>
            </div>
            {report.by_service.length === 0 ? (
              <EmptyState title="No service data" description="No request was raised in this window." />
            ) : (
              <div className="scrollbar-thin overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-stitch text-[9px] uppercase tracking-wider text-stone">
                      <th className="py-2 pr-3 font-medium">Service</th>
                      <th className="py-2 pr-3 font-medium">Requests</th>
                      <th className="py-2 pr-3 font-medium">Closed</th>
                      <th className="py-2 pr-3 font-medium">Met</th>
                      <th className="py-2 font-medium">Compliance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stitch">
                    {report.by_service.map((service) => {
                      const meta = complianceTone(service.compliance_pct);
                      return (
                        <tr key={service.service_name}>
                          <td className="py-2.5 pr-3 text-[11px] font-medium">{service.service_name}</td>
                          <td className="py-2.5 pr-3">
                            <span className="mono text-[11px]">{service.requests}</span>
                          </td>
                          <td className="py-2.5 pr-3">
                            <span className="mono text-[11px]">{service.closed}</span>
                          </td>
                          <td className="py-2.5 pr-3">
                            <span className="mono text-[11px]">{service.met}</span>
                          </td>
                          <td className="py-2.5">
                            <div className="flex items-center gap-2">
                              <ComplianceBar pct={service.compliance_pct} className="w-28" />
                              <span className={cx('mono text-[11px] font-medium', meta.text)}>
                                {service.compliance_pct}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
