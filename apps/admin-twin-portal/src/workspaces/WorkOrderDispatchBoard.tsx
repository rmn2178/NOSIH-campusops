import { useMemo, useState } from 'react';
import { ArrowUpRight, PackageCheck, RefreshCcw, UserCheck, Wrench } from 'lucide-react';
import { api } from '../api/client';
import { UnavailableResourcesModal } from '../components/modals/UnavailableResourcesModal';
import { Badge, Button, EmptyState, ErrorBanner, Panel, StatusBadge, cx } from '../components/ui';
import type { ActionMode } from '../components/twin3d/SpaceInspectorDrawer';
import { useAuthStore } from '../store/authStore';
import { usePortalStore } from '../store/portalStore';
import type { SlaClock, WorkOrder } from '../types';

const statuses = ['ALL', 'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED_PARTS', 'RESOLVED'];

export function WorkOrderDispatchBoard({ workOrders, slaClocks, onChanged }: { workOrders: WorkOrder[]; slaClocks: SlaClock[]; onChanged: () => void }) {
  const { user } = useAuthStore();
  const { selectSpace, setWorkspace, invalidateTwin } = usePortalStore();
  const [filter, setFilter] = useState('ALL');
  const [action, setAction] = useState<{ mode: ActionMode; workOrder: WorkOrder } | null>(null);
  const [staffCode, setStaffCode] = useState('');
  const [trigger, setTrigger] = useState<'SHIFT_ENDED' | 'MARKED_LEAVE' | 'PREEMPTED_BY_CRITICAL'>('SHIFT_ENDED');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slaByWorkOrder = useMemo(() => new Map(slaClocks.map((clock) => [clock.work_order_id, clock])), [slaClocks]);
  const filtered = useMemo(() => {
    const rows = filter === 'ALL' ? workOrders : workOrders.filter((order) => order.status === filter);
    const closed = (status: string) => status === 'RESOLVED' || status === 'CLOSED';
    const risk = (clock?: SlaClock) => !clock || clock.is_paused
      ? 2
      : clock.breach_state === 'BREACHED_100' ? 0 : clock.breach_state === 'WARNING_75' ? 1 : 2;
    return [...rows].sort((a, b) => {
      const statusDelta = Number(closed(a.status)) - Number(closed(b.status));
      if (statusDelta !== 0) return statusDelta;
      const aClock = slaByWorkOrder.get(a.id);
      const bClock = slaByWorkOrder.get(b.id);
      const riskDelta = risk(aClock) - risk(bClock);
      if (riskDelta !== 0) return riskDelta;
      const minutesDelta = (aClock?.remaining_minutes ?? 9999) - (bClock?.remaining_minutes ?? 9999);
      if (minutesDelta !== 0) return minutesDelta;
      return (b.priority_score ?? 0) - (a.priority_score ?? 0);
    });
  }, [filter, slaByWorkOrder, workOrders]);
  const staffCodes = useMemo(() => Array.from(new Set(workOrders.map((order) => order.assigned_staff_code).filter((code): code is string => Boolean(code)))), [workOrders]);
  const canAssign = user && ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'].includes(user.role);

  const rebalance = async () => {
    if (!staffCode) return;
    setBusy(true); setError(null);
    try { await api.operations.rebalanceStaff(staffCode, trigger); invalidateTwin('Technician constraint changed; work orders rebalanced by the server'); onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Automatic reassignment failed'); }
    finally { setBusy(false); }
  };

  return <Panel className="overflow-hidden">
    <div className="border-b border-stitch px-5 py-4"><div className="flex flex-wrap items-center gap-2"><Wrench className="h-4 w-4" /><h2 className="text-sm font-semibold">Work order dispatch</h2><Badge tone="neutral" className="ml-auto">{workOrders.filter((order) => !['RESOLVED', 'CLOSED'].includes(order.status)).length} open</Badge></div><div className="mt-3 flex flex-wrap gap-1">{statuses.map((status) => <button key={status} onClick={() => setFilter(status)} className={cx('rounded-md px-2.5 py-1.5 text-[9px] font-medium', filter === status ? 'bg-obsidian text-white' : 'bg-silk text-stone')}>{status.replaceAll('_', ' ')}</button>)}</div><p className="mt-2 text-[10px] text-stone">Queue sorted by SLA breach risk, then minutes remaining, then priority.</p></div>
    {canAssign && <div className="border-b border-stitch bg-silk/50 p-4"><p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider"><RefreshCcw className="h-3.5 w-3.5" />Shift change / leave trigger</p><div className="flex flex-col gap-2 sm:flex-row"><select aria-label="Technician for constraint change" value={staffCode} onChange={(event) => setStaffCode(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-stitch bg-white px-3 text-xs"><option value="">Select assigned technician</option>{staffCodes.map((code) => <option key={code}>{code}</option>)}</select><select aria-label="Constraint change reason" value={trigger} onChange={(event) => setTrigger(event.target.value as typeof trigger)} className="h-9 rounded-lg border border-stitch bg-white px-3 text-xs"><option value="SHIFT_ENDED">Shift ended</option><option value="MARKED_LEAVE">Marked leave</option><option value="PREEMPTED_BY_CRITICAL">Preempted by critical</option></select><Button size="sm" disabled={!staffCode || busy} onClick={() => void rebalance()}>{busy ? 'Rebalancing…' : 'Apply & auto-reassign'}</Button></div><p className="mt-2 text-[10px] text-stone">The server re-runs all hard gates and assignment scoring for every affected open work order.</p></div>}
    {error && <div className="p-4"><ErrorBanner message={error} /></div>}
    <div className="scrollbar-thin max-h-[560px] overflow-y-auto p-3">{filtered.length === 0 ? <EmptyState title="No work orders in this state" description="Change the status filter or wait for a verified complaint to create operational work." /> : <div className="space-y-2">{filtered.map((order) => { const sla = slaByWorkOrder.get(order.id); return <article key={order.id} className="rounded-xl border border-stitch bg-white p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex items-center gap-2"><span className="mono text-[10px] font-semibold">{order.work_order_number}</span><StatusBadge status={order.priority} /></div><button onClick={() => { selectSpace(order.space_code); setWorkspace('twin'); }} className="mono mt-2 flex items-center gap-1 text-xs font-medium hover:underline">{order.space_code}<ArrowUpRight className="h-3 w-3" /></button></div><StatusBadge status={order.status} />{sla && !['RESOLVED', 'CLOSED'].includes(order.status) && <Badge tone={sla.breach_state === 'BREACHED_100' ? 'red' : sla.breach_state === 'WARNING_75' ? 'amber' : 'neutral'}>{sla.is_paused ? 'SLA paused' : sla.breach_state === 'BREACHED_100' ? 'SLA breached' : `${sla.remaining_minutes}m left`}</Badge>}</div><p className="mt-3 text-xs leading-5 text-stone">{order.title ?? order.description ?? `${order.required_skill} maintenance required`}</p><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-stone"><span>{order.required_skill}</span><span>{order.required_risk_clearance}</span><span>{order.assigned_staff_name ?? order.assigned_staff_code ?? 'Unassigned'}</span>{order.reassignment_count !== undefined && order.reassignment_count > 0 && <span>{order.reassignment_count} reassignments</span>}</div>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-stitch pt-3">{canAssign && <Button size="sm" variant="secondary" disabled={['RESOLVED', 'CLOSED'].includes(order.status)} onClick={() => setAction({ mode: 'staff', workOrder: order })}><UserCheck className="h-3.5 w-3.5" />Rank & assign</Button>}<Button size="sm" variant="secondary" disabled={['RESOLVED', 'CLOSED'].includes(order.status)} onClick={() => setAction({ mode: 'parts', workOrder: order })}><PackageCheck className="h-3.5 w-3.5" />Reserve parts</Button></div>
    </article>; })}</div>}</div>
    {action && <UnavailableResourcesModal open onClose={() => setAction(null)} mode={action.mode} spaceCode={action.workOrder.space_code} workOrder={action.workOrder} onCompleted={() => { setAction(null); invalidateTwin('Work order updated by the server'); onChanged(); }} />}
  </Panel>;
}
