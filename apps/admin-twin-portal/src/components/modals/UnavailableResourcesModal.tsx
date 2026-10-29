import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, LockKeyhole, PackageCheck, TimerReset, Unlock, UserCheck } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import type {
  CampusClock, PartRequest, PartsPreflightResult, ResourceLock, ResourceType,
  RoomConflictResult, StaffRankingResult, WorkOrder,
} from '../../types';
import { Badge, Button, CheckItem, EmptyState, ErrorBanner, Modal, Spinner, cx } from '../ui';
import type { ActionMode } from '../twin3d/SpaceInspectorDrawer';

const titles: Record<ActionMode, { title: string; description: string; action: string }> = {
  relocate: { title: 'Resolve relocation constraints', description: 'Ranked vacancy, deterministic exclusions and atomic room ownership are verified before any timetable mutation.', action: 'Relocate affected class' },
  staff: { title: 'Resolve technician constraints', description: 'Skills, risk clearance, shift capacity and staff locks are evaluated before assignment.', action: 'Assign selected technician' },
  parts: { title: 'Resolve inventory constraints', description: 'Stock availability is checked atomically. A shortage blocks the complete reservation without partial allocation.', action: 'Reserve requested parts' },
};

export function UnavailableResourcesModal({ open, onClose, onCompleted, mode, spaceCode, workOrder }: {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
  mode: ActionMode;
  spaceCode: string;
  workOrder?: WorkOrder | null;
}) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomResult, setRoomResult] = useState<RoomConflictResult | null>(null);
  const [staffResult, setStaffResult] = useState<StaffRankingResult | null>(null);
  const [partsResult, setPartsResult] = useState<PartsPreflightResult | null>(null);
  const [clock, setClock] = useState<CampusClock | null>(null);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [lock, setLock] = useState<ResourceLock | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [showWhy, setShowWhy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true); setError(null); setSelectedResource(null); setLock(null);
    try {
      if (mode === 'relocate') {
        const campusClock = await api.clock.get();
        setClock(campusClock);
        setRoomResult(await api.operations.roomConflicts(spaceCode, campusClock.day_of_week, campusClock.active_period ?? 1));
      } else if (workOrder) {
        if (mode === 'staff') setStaffResult(await api.operations.staffRanking(workOrder.id));
        else setPartsResult(await api.operations.partsPreflight(workOrder.id));
      } else throw new Error('An active work order is required for this operation.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to evaluate constraints'); }
    finally { setLoading(false); }
  }, [open, mode, spaceCode, workOrder]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!lock) return;
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((new Date(lock.expires_at).getTime() - Date.now()) / 1000)));
    update();
    const countdown = window.setInterval(update, 1000);
    const heartbeat = window.setInterval(() => {
      api.locks.heartbeat(lock.id).then(setLock).catch((reason) => { setLock(null); setError(reason instanceof Error ? reason.message : 'Lock heartbeat failed'); });
    }, 60_000);
    return () => { window.clearInterval(countdown); window.clearInterval(heartbeat); };
  }, [lock]);

  const resource = useMemo<{ type: ResourceType; id: string } | null>(() => {
    if (mode === 'parts') return workOrder ? { type: 'WORK_ORDER', id: workOrder.id } : null;
    return selectedResource ? { type: mode === 'relocate' ? 'ROOM' : 'STAFF', id: selectedResource } : null;
  }, [mode, selectedResource, workOrder]);

  const releaseLock = useCallback(() => {
    if (lock) void api.locks.release(lock.id).catch(() => undefined);
    setLock(null);
  }, [lock]);
  const close = () => { releaseLock(); onClose(); };

  const claim = async () => {
    if (!resource) return;
    setError(null); setSubmitting(true);
    try { setLock(await api.locks.claim(resource.type, resource.id)); }
    catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && typeof reason.body === 'object' && reason.body !== null) {
        const body = reason.body as { locked_by_name?: string; locked_by_role?: string; acquired_seconds_ago?: number; detail?: { locked_by_name?: string; locked_by_role?: string; acquired_seconds_ago?: number } };
        const conflict = { ...body, ...body.detail };
        setError(`Locked by ${conflict.locked_by_name ?? 'another administrator'} [${conflict.locked_by_role?.replaceAll('_', ' ') ?? 'Unknown role'}] ${conflict.acquired_seconds_ago ?? 0}s ago — allocation blocked`);
      } else setError(reason instanceof Error ? reason.message : 'Lock claim rejected');
    } finally { setSubmitting(false); }
  };

  const execute = async () => {
    if (!lock || !resource) return;
    setSubmitting(true); setError(null);
    try {
      if (mode === 'relocate') {
        if (!clock) throw new Error('Campus clock context is unavailable.');
        await api.operations.relocate({
          faulted_space_code: spaceCode,
          target_alternate_code: resource.id,
          day_of_week: clock.day_of_week,
          from_period: clock.active_period ?? 1,
          lock_id: lock.id,
        });
      } else if (mode === 'staff' && workOrder) {
        await api.operations.assignStaff(workOrder.id, resource.id, lock.id);
      } else if (mode === 'parts' && workOrder && partsResult) {
        const parts: PartRequest[] = partsResult.requested_parts;
        await api.operations.reserveParts(workOrder.id, parts, lock.id);
      }
      setLock(null);
      onCompleted();
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The backend rejected this operation'); }
    finally { setSubmitting(false); }
  };

  const checks = roomResult?.preflight_checks ?? staffResult?.preflight_checks ?? partsResult?.preflight_checks ?? [];
  const canExecute = Boolean(lock && secondsLeft > 0 && (mode === 'parts' || selectedResource));
  const availableCount = mode === 'relocate' ? roomResult?.available_alternates.length : mode === 'staff' ? staffResult?.available_ranked.length : partsResult?.available_parts.length;
  const unavailableCount = mode === 'relocate' ? roomResult?.unavailable_spaces.length : mode === 'staff' ? staffResult?.unavailable_staff.length : partsResult?.unavailable_parts.length;

  return <Modal open={open} onClose={close} title={titles[mode].title} description={titles[mode].description} wide>
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      <section className={cx('rounded-xl border p-4', lock ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50')}>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div className="flex gap-3"><div className={cx('rounded-lg p-2', lock ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800')}>{lock ? <Unlock className="h-5 w-5" /> : <LockKeyhole className="h-5 w-5" />}</div><div><p className="text-sm font-medium">{lock ? 'Exclusive resource lock held' : 'Atomic resource lock required'}</p><p className="mt-1 text-xs leading-5 text-stone">{lock ? <><span className="mono">{lock.resource_type} / {lock.resource_id}</span> · {secondsLeft}s remaining</> : resource ? <>Claim <span className="mono">{resource.type} / {resource.id}</span> for a 300-second allocation window.</> : mode === 'parts' ? 'Resolving work-order resource…' : 'Select an available option below before claiming its lock.'}</p></div></div>
          <div className="flex gap-2">{lock ? <Button variant="secondary" size="sm" onClick={releaseLock}><TimerReset className="h-3.5 w-3.5" />Release lock</Button> : <Button size="sm" disabled={!resource || submitting} onClick={() => void claim()}><LockKeyhole className="h-3.5 w-3.5" />{submitting ? 'Claiming…' : 'Claim 300s exclusive lock'}</Button>}</div></div>
      </section>

      {loading ? <Spinner label="Evaluating deterministic constraints" /> : <div className="grid gap-4 xl:grid-cols-3">
        <section className="rounded-xl border border-stitch bg-white p-4"><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-semibold">Available & ranked</p><p className="mt-1 text-[10px] text-stone">Deterministic server evaluation</p></div><Badge tone="green">{availableCount ?? 0}</Badge></div>
          <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
            {mode === 'relocate' && roomResult?.available_alternates.map((room, index) => <div key={room.space_code} className={cx('rounded-lg border p-3 transition', selectedResource === room.space_code ? 'border-obsidian ring-1 ring-obsidian' : 'border-stitch bg-[#fdfcf9]')}><button className="w-full text-left" onClick={() => { setSelectedResource(room.space_code); setLock(null); }}><div className="flex items-center justify-between"><span className="mono text-xs font-semibold">{index + 1}. {room.space_code}</span><Badge tone="green">Score {room.score.toFixed(1)}</Badge></div><p className="mt-2 text-[10px] leading-4 text-stone">{room.explanation}</p></button><button onClick={() => setShowWhy(showWhy === room.space_code ? null : room.space_code)} className="mt-2 flex items-center gap-1 text-[10px] font-medium text-stone hover:text-obsidian"><Info className="h-3 w-3" />Why this score?</button>{showWhy === room.space_code && <pre className="mono mt-2 whitespace-pre-wrap rounded-md bg-silk p-2 text-[9px] leading-4 text-stone">{JSON.stringify(room.score_breakdown ?? { deterministic_score: room.score, explanation: room.explanation }, null, 2)}</pre>}</div>)}
            {mode === 'staff' && staffResult?.available_ranked.map((staff, index) => <div key={staff.staff_code} className={cx('rounded-lg border p-3', selectedResource === staff.staff_code ? 'border-obsidian ring-1 ring-obsidian' : 'border-stitch')}><button className="w-full text-left" onClick={() => { setSelectedResource(staff.staff_code); setLock(null); }}><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{index + 1}. {staff.full_name}</span><Badge tone="green">{staff.score.toFixed(1)}</Badge></div><p className="mono mt-1 text-[9px] text-stone">{staff.staff_code} · {staff.primary_skill}</p><p className="mt-2 text-[10px] text-stone">{staff.risk_clearance} · {staff.current_active_jobs}/{staff.max_concurrent_jobs} active jobs</p></button><button onClick={() => setShowWhy(showWhy === staff.staff_code ? null : staff.staff_code)} className="mt-2 flex items-center gap-1 text-[10px] font-medium text-stone"><Info className="h-3 w-3" />Why this score?</button>{showWhy === staff.staff_code && <div className="mt-2 space-y-1 rounded-md bg-silk p-2">{Object.entries(staff.score_breakdown).map(([key, value]) => <div key={key} className="mono flex justify-between text-[9px]"><span>{key.replaceAll('_', ' ')}</span><span>{value > 0 ? '+' : ''}{value.toFixed(2)}</span></div>)}</div>}</div>)}
            {mode === 'parts' && partsResult?.available_parts.map((part) => <div key={part.sku_code} className="rounded-lg border border-stitch p-3"><div className="flex items-center gap-2"><PackageCheck className="h-4 w-4 text-emerald-700" /><span className="mono text-xs font-semibold">{part.sku_code}</span></div><p className="mt-1 text-xs">{part.name}</p><p className="mt-2 text-[10px] text-stone">{part.available_qty} {part.unit} available · {part.reserved_qty} reserved</p></div>)}
            {availableCount === 0 && <EmptyState title="No available resources" description="Review the explicit exclusions and resolve the blocking constraints before retrying." />}
          </div>
        </section>

        <section className="rounded-xl border border-stitch bg-white p-4"><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-semibold">Unavailable resources</p><p className="mt-1 text-[10px] text-stone">Exact rejection reasons</p></div><Badge tone="red">{unavailableCount ?? 0}</Badge></div><div className="max-h-[420px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
          {(mode === 'relocate' ? roomResult?.unavailable_spaces : mode === 'staff' ? staffResult?.unavailable_staff : partsResult?.unavailable_parts)?.map((resourceItem) => <div key={resourceItem.code} className="rounded-lg border border-red-100 bg-red-50/50 p-3"><div className="flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5 text-red-700" /><span className="mono text-[10px] font-semibold">{resourceItem.code}</span></div>{resourceItem.name && <p className="mt-1 text-[11px]">{resourceItem.name}</p>}<p className="mt-2 text-[10px] font-medium leading-4 text-red-900">{resourceItem.reason.replaceAll('_', ' ')}</p></div>)}
          {unavailableCount === 0 && <EmptyState title="No exclusions" description="Every evaluated resource passed the applicable hard constraints." icon={<CheckCircle2 className="h-5 w-5" />} />}
        </div></section>

        <section className="rounded-xl border border-stitch bg-white p-4"><div className="mb-4"><p className="text-xs font-semibold">Pre-flight constraint checklist</p><p className="mt-1 text-[10px] text-stone">Server checks plus local lock context</p></div><div className="space-y-2">{checks.map((check) => <CheckItem key={`${check.rule}-${check.label}`} passed={check.passed} label={check.label || check.rule} detail={check.detail} />)}<CheckItem passed={Boolean(lock && secondsLeft > 0)} label="LOCK_OWNERSHIP" detail={lock ? `Exclusive lock held for ${secondsLeft} more seconds` : 'Claim the selected resource before executing'} />
          {mode === 'relocate' && roomResult && <div className="mt-3 rounded-lg bg-silk p-3"><p className="text-[10px] font-semibold uppercase tracking-wider">Affected sessions</p>{roomResult.affected_sessions.map((session) => <p key={`${session.period_number}-${session.class_code}`} className="mono mt-2 text-[9px] leading-4 text-stone">P{session.period_number} · {session.class_code} · {session.student_strength} students<br />{session.subject_title}</p>)}</div>}
        </div></section>
      </div>}

      <footer className="flex flex-col-reverse justify-between gap-3 border-t border-stitch pt-4 sm:flex-row sm:items-center"><p className="flex items-center gap-1.5 text-[10px] text-stone"><UserCheck className="h-3.5 w-3.5" />Backend RBAC and lock ownership are checked again on execution.</p><Button disabled={!canExecute || submitting} onClick={() => void execute()}>{submitting ? 'Executing transaction…' : titles[mode].action}<ArrowRight className="h-4 w-4" /></Button></footer>
    </div>
  </Modal>;
}
