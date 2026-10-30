import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, LockKeyhole, PackageCheck, TimerReset, Unlock, UserCheck } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import type {
  CampusClock, ConstraintCheck, PartRequest, PartsPreflightResult, ResourceLock, ResourceType,
  RoomConflictResult, StaffCandidate, StaffRankingResult, WorkOrder,
} from '../../types';
import { Badge, Button, CheckItem, EmptyState, ErrorBanner, Modal, Spinner, cx } from '../ui';
import type { ActionMode } from '../twin3d/SpaceInspectorDrawer';

const titles: Record<ActionMode, { title: string; description: string; action: string; claimAction: string }> = {
  relocate: { title: 'Resolve relocation constraints', description: 'Ranked vacancy, deterministic exclusions and atomic room ownership are verified before any timetable mutation.', action: 'Relocate affected class', claimAction: 'Claim lock & relocate' },
  staff: { title: 'Resolve technician constraints', description: 'Skills, risk clearance, shift capacity and staff locks are evaluated before assignment.', action: 'Assign selected technician', claimAction: 'Claim lock & assign' },
  parts: { title: 'Resolve inventory constraints', description: 'Stock availability is checked atomically. A shortage blocks the complete reservation without partial allocation.', action: 'Reserve requested parts', claimAction: 'Claim lock & reserve' },
};

function lockConflictMessage(reason: unknown): string {
  if (reason instanceof ApiError && reason.status === 409 && typeof reason.body === 'object' && reason.body !== null) {
    const body = reason.body as {
      locked_by_name?: string; locked_by_role?: string; acquired_seconds_ago?: number;
      detail?: { locked_by_name?: string; locked_by_role?: string; acquired_seconds_ago?: number };
    };
    const conflict = { ...body, ...body.detail };
    return `Locked by ${conflict.locked_by_name ?? 'another administrator'} [${conflict.locked_by_role?.replaceAll('_', ' ') ?? 'Unknown role'}] ${conflict.acquired_seconds_ago ?? 0}s ago — allocation blocked`;
  }
  return reason instanceof Error ? reason.message : 'Lock claim rejected';
}

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
        const result = await api.operations.roomConflicts(spaceCode, campusClock.day_of_week, campusClock.active_period ?? 1);
        setRoomResult(result);
        setSelectedResource(result.available_alternates[0]?.space_code ?? null);
      } else if (workOrder) {
        if (mode === 'staff') {
          const result = await api.operations.staffRanking(workOrder.id);
          setStaffResult(result);
          setSelectedResource(result.available_ranked[0]?.staff_code ?? null);
        } else {
          setPartsResult(await api.operations.partsPreflight(workOrder.id));
        }
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

  const selectedStaff = useMemo<StaffCandidate | null>(
    () => staffResult?.available_ranked.find((staff) => staff.staff_code === selectedResource) ?? null,
    [staffResult, selectedResource],
  );

  const releaseLock = useCallback(() => {
    if (lock) void api.locks.release(lock.id).catch(() => undefined);
    setLock(null);
  }, [lock]);
  const close = () => { releaseLock(); onClose(); };

  const chooseResource = (code: string) => {
    if (code === selectedResource) return;
    if (lock) void api.locks.release(lock.id).catch(() => undefined);
    setLock(null);
    setSelectedResource(code);
  };

  const claim = async () => {
    if (!resource) return;
    setError(null); setSubmitting(true);
    try { setLock(await api.locks.claim(resource.type, resource.id)); }
    catch (reason) { setError(lockConflictMessage(reason)); }
    finally { setSubmitting(false); }
  };

  const execute = async () => {
    if (!resource) return;
    setSubmitting(true); setError(null);
    try {
      let activeLock = lock && secondsLeft > 0 ? lock : null;
      if (!activeLock) {
        try {
          activeLock = await api.locks.claim(resource.type, resource.id);
          setLock(activeLock);
        } catch (reason) {
          setError(lockConflictMessage(reason));
          return;
        }
      }
      if (!activeLock) return;
      if (mode === 'relocate') {
        if (!clock) throw new Error('Campus clock context is unavailable.');
        await api.operations.relocate({
          faulted_space_code: spaceCode,
          target_alternate_code: resource.id,
          day_of_week: clock.day_of_week,
          from_period: clock.active_period ?? 1,
          lock_id: activeLock.id,
        });
      } else if (mode === 'staff' && workOrder) {
        await api.operations.assignStaff(workOrder.id, resource.id, activeLock.id);
      } else if (mode === 'parts' && workOrder && partsResult) {
        const parts: PartRequest[] = partsResult.requested_parts;
        await api.operations.reserveParts(workOrder.id, parts, activeLock.id);
      }
      setLock(null);
      onCompleted();
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The backend rejected this operation'); }
    finally { setSubmitting(false); }
  };

  const staffChecks = useMemo<ConstraintCheck[]>(() => {
    if (mode !== 'staff' || !selectedStaff) return [];
    const requiredSkill = workOrder?.required_skill ?? '';
    const requiredRisk = workOrder?.required_risk_clearance ?? 'STANDARD';
    const onShift = selectedStaff.is_on_shift !== false && !selectedStaff.is_on_leave;
    return [
      {
        rule: 'PRIMARY_SKILL',
        label: 'Primary skill',
        passed: selectedStaff.primary_skill === requiredSkill,
        detail: `${selectedStaff.primary_skill} vs required ${requiredSkill || 'unknown'}`,
      },
      {
        rule: 'RISK_CLEARANCE',
        label: 'Risk clearance',
        passed: requiredRisk === 'STANDARD' || selectedStaff.risk_clearance === requiredRisk,
        detail: `${selectedStaff.risk_clearance} vs required ${requiredRisk}`,
      },
      {
        rule: 'SHIFT_WINDOW',
        label: 'Shift availability',
        passed: onShift,
        detail: onShift
          ? `On shift and not on leave${selectedStaff.current_block_location ? ` · block ${selectedStaff.current_block_location}` : ''}`
          : 'Currently off shift or on leave',
      },
      {
        rule: 'WORKLOAD_CAPACITY',
        label: 'Workload capacity',
        passed: selectedStaff.current_active_jobs < selectedStaff.max_concurrent_jobs,
        detail: `${selectedStaff.current_active_jobs} of ${selectedStaff.max_concurrent_jobs} slots in use`,
      },
    ];
  }, [mode, selectedStaff, workOrder]);

  const serverChecks = roomResult?.preflight_checks ?? staffResult?.preflight_checks ?? partsResult?.preflight_checks ?? [];

  const roomChecks = useMemo<ConstraintCheck[]>(() => {
    if (mode !== 'relocate' || !roomResult) return [];
    const room = roomResult.available_alternates.find((candidate) => candidate.space_code === selectedResource);
    const session = roomResult.affected_sessions[0];
    if (!room) return [];
    return [{
      rule: 'CAPACITY_FIT',
      label: 'Capacity fit',
      passed: !room.capacity || !session || room.capacity >= session.student_strength,
      detail: room.capacity && session
        ? `${session.student_strength} students vs ${room.capacity} seats`
        : 'Capacity not reported by the server',
    }];
  }, [mode, roomResult, selectedResource]);

  const checks = mode === 'staff' ? staffChecks : mode === 'relocate' ? roomChecks : serverChecks;
  const canExecute = Boolean(resource) && (mode !== 'parts' || Boolean(partsResult));
  const lockHeld = Boolean(lock && secondsLeft > 0);
  const primaryLabel = lock ? titles[mode].action : titles[mode].claimAction;
  const availableCount = mode === 'relocate' ? roomResult?.available_alternates.length : mode === 'staff' ? staffResult?.available_ranked.length : partsResult?.available_parts.length;
  const unavailableCount = mode === 'relocate' ? roomResult?.unavailable_spaces.length : mode === 'staff' ? staffResult?.unavailable_staff.length : partsResult?.unavailable_parts.length;

  return <Modal open={open} onClose={close} title={titles[mode].title} description={titles[mode].description} wide>
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      <section className={cx('rounded-xl border p-4', lock ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50')}>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div className="flex gap-3"><div className={cx('rounded-lg p-2', lock ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800')}>{lock ? <Unlock className="h-5 w-5" /> : <LockKeyhole className="h-5 w-5" />}</div><div><p className="text-sm font-medium">{lock ? 'Exclusive resource lock held' : 'Atomic resource lock required'}</p><p className="mt-1 text-xs leading-5 text-stone">{lock ? <><span className="mono">{lock.resource_type} / {lock.resource_id}</span> · {secondsLeft}s remaining</> : resource ? <>Claim <span className="mono">{resource.type} / {resource.id}</span> for a 300-second window — or use the action below to claim and execute in one step.</> : mode === 'parts' ? 'Resolving work-order resource…' : 'Select an available option below before claiming its lock.'}</p></div></div>
          <div className="flex gap-2">{lock ? <Button variant="secondary" size="sm" onClick={releaseLock}><TimerReset className="h-3.5 w-3.5" />Release lock</Button> : <Button size="sm" disabled={!resource || submitting} onClick={() => void claim()}><LockKeyhole className="h-3.5 w-3.5" />{submitting ? 'Claiming…' : 'Claim 300s exclusive lock'}</Button>}</div></div>
      </section>

      {loading ? <Spinner label="Evaluating deterministic constraints" /> : <div className="grid gap-4 xl:grid-cols-3">
        <section className="rounded-xl border border-stitch bg-white p-4"><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-semibold">Available & ranked</p><p className="mt-1 text-[10px] text-stone">Deterministic server evaluation</p></div><Badge tone="green">{availableCount ?? 0}</Badge></div>
          <div className="max-h-[400px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
            {mode === 'relocate' && roomResult?.available_alternates.map((room, index) => <div key={room.space_code} className={cx('rounded-lg border p-3 transition', selectedResource === room.space_code ? 'border-obsidian ring-1 ring-obsidian' : 'border-stitch bg-[#fdfcf9]')}><button className="w-full text-left" aria-pressed={selectedResource === room.space_code} onClick={() => chooseResource(room.space_code)}><div className="flex items-center justify-between"><span className="mono text-xs font-semibold">{index + 1}. {room.space_code}</span><div className="flex items-center gap-1.5">{index === 0 && <Badge tone="green">Top pick</Badge>}<Badge tone="green">Score {room.score.toFixed(1)}</Badge></div></div><p className="mt-2 text-[10px] leading-4 text-stone">{room.explanation}</p></button>{selectedResource === room.space_code && <p className="mt-2 text-[9px] font-semibold uppercase tracking-[.12em] text-obsidian">Selected</p>}<button onClick={() => setShowWhy(showWhy === room.space_code ? null : room.space_code)} className="mt-2 flex items-center gap-1 text-[10px] font-medium text-stone hover:text-obsidian"><Info className="h-3 w-3" />Why this score?</button>{showWhy === room.space_code && <pre className="mono mt-2 whitespace-pre-wrap rounded-md bg-silk p-2 text-[9px] leading-4 text-stone">{JSON.stringify(room.score_breakdown ?? { deterministic_score: room.score, explanation: room.explanation }, null, 2)}</pre>}</div>)}
            {mode === 'staff' && staffResult?.available_ranked.map((staff, index) => <div key={staff.staff_code} className={cx('rounded-lg border p-3', selectedResource === staff.staff_code ? 'border-obsidian ring-1 ring-obsidian' : 'border-stitch')}><button className="w-full text-left" aria-pressed={selectedResource === staff.staff_code} onClick={() => chooseResource(staff.staff_code)}><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{index + 1}. {staff.full_name}</span><div className="flex items-center gap-1.5">{index === 0 && <Badge tone="green">Top pick</Badge>}<Badge tone="green">{staff.score.toFixed(1)}</Badge></div></div><p className="mono mt-1 text-[9px] text-stone">{staff.staff_code} · {staff.primary_skill} · {staff.risk_clearance}</p><div className="mt-2 flex items-center justify-between gap-2"><p className="text-[10px] text-stone">{staff.current_block_location ? `Block ${staff.current_block_location} · ` : ''}{staff.current_active_jobs}/{staff.max_concurrent_jobs} active jobs</p>{selectedResource === staff.staff_code && <Badge tone="neutral">Selected</Badge>}</div></button><button onClick={() => setShowWhy(showWhy === staff.staff_code ? null : staff.staff_code)} className="mt-2 flex items-center gap-1 text-[10px] font-medium text-stone"><Info className="h-3 w-3" />Why this score?</button>{showWhy === staff.staff_code && <div className="mt-2 space-y-1 rounded-md bg-silk p-2">{Object.entries(staff.score_breakdown).map(([key, value]) => <div key={key} className="mono flex justify-between text-[9px]"><span>{key.replaceAll('_', ' ')}</span><span>{value > 0 ? '+' : ''}{value.toFixed(2)}</span></div>)}</div>}</div>)}
            {mode === 'parts' && partsResult?.available_parts.map((part) => <div key={part.sku_code} className="rounded-lg border border-stitch p-3"><div className="flex items-center gap-2"><PackageCheck className="h-4 w-4 text-emerald-700" /><span className="mono text-xs font-semibold">{part.sku_code}</span></div><p className="mt-1 text-xs">{part.name}</p><p className="mt-2 text-[10px] text-stone">{part.available_qty} {part.unit} available · {part.reserved_qty} reserved</p></div>)}
            {availableCount === 0 && <EmptyState title="No available resources" description="Review the explicit exclusions and resolve the blocking constraints before retrying." />}
          </div>
        </section>

        <section className="rounded-xl border border-stitch bg-white p-4"><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-semibold">Unavailable resources</p><p className="mt-1 text-[10px] text-stone">Exact rejection reasons</p></div><Badge tone="red">{unavailableCount ?? 0}</Badge></div><div className="max-h-[400px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
          {(mode === 'relocate' ? roomResult?.unavailable_spaces : mode === 'staff' ? staffResult?.unavailable_staff : partsResult?.unavailable_parts)?.map((resourceItem) => <div key={resourceItem.code} className="rounded-lg border border-red-100 bg-red-50/50 p-3"><div className="flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5 text-red-700" /><span className="mono text-[10px] font-semibold">{resourceItem.code}</span></div>{resourceItem.name && <p className="mt-1 text-[11px]">{resourceItem.name}</p>}<p className="mt-2 text-[10px] font-medium leading-4 text-red-900">{resourceItem.reason.replaceAll('_', ' ')}</p></div>)}
          {unavailableCount === 0 && <EmptyState title="No exclusions" description="Every evaluated resource passed the applicable hard constraints." icon={<CheckCircle2 className="h-5 w-5" />} />}
        </div></section>

        <section className="rounded-xl border border-stitch bg-white p-4"><div className="mb-4"><p className="text-xs font-semibold">Pre-flight constraint checklist</p><p className="mt-1 text-[10px] text-stone">{mode === 'staff' && selectedStaff ? `Evaluating ${selectedStaff.staff_code} · ${selectedStaff.full_name}` : 'Server checks plus local lock context'}</p></div><div className="space-y-2">{checks.map((check) => <CheckItem key={`${check.rule}-${check.label}`} passed={check.passed} label={check.label || check.rule} detail={check.detail} />)}{mode === 'staff' && !selectedStaff && <p className="rounded-lg border border-dashed border-stitch p-3 text-[11px] leading-4 text-stone">Select a technician to evaluate skill, clearance, shift and workload.</p>}<CheckItem passed={lockHeld} label="LOCK_OWNERSHIP" detail={lockHeld ? `Exclusive lock held for ${secondsLeft} more seconds; executing this allocation will consume it` : 'Claim the selected resource before executing, or let the action claim it for you'} />
          {mode === 'relocate' && roomResult && <div className="mt-3 rounded-lg bg-silk p-3"><p className="text-[10px] font-semibold uppercase tracking-wider">Affected sessions</p>{roomResult.affected_sessions.map((session) => <p key={`${session.period_number}-${session.class_code}`} className="mono mt-2 text-[9px] leading-4 text-stone">P{session.period_number} · {session.class_code} · {session.student_strength} students<br />{session.subject_title}</p>)}</div>}
        </div></section>
      </div>}

      <footer className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-1 flex flex-col-reverse justify-between gap-3 border-t border-stitch bg-linen/95 px-5 py-4 backdrop-blur sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:px-6"><p className="flex items-center gap-1.5 text-[10px] text-stone"><UserCheck className="h-3.5 w-3.5" />{lockHeld ? `Lock held · ${secondsLeft}s · ` : ''}Backend RBAC and lock ownership are checked again on execution.</p><Button disabled={!canExecute || submitting} onClick={() => void execute()}>{submitting ? 'Executing transaction…' : primaryLabel}<ArrowRight className="h-4 w-4" /></Button></footer>
    </div>
  </Modal>;
}
