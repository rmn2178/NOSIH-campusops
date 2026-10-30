import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftRight, Bot, Box, CheckCircle2, ChevronRight, Clock3,
  Cpu, Fan, FileText, Lightbulb, LockKeyhole, MessageSquare, PackageCheck,
  PanelTop, RotateCcw, ShieldCheck, UserRound, UsersRound, Wrench, X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { usePortalStore } from '../../store/portalStore';
import type { Asset, PeriodCard, Role, SpaceDetail } from '../../types';
import { Badge, Button, ErrorBanner, Modal, Spinner, StatusBadge, assetShortLabel, cx, formatDate } from '../ui';
import { AssetRecordPanel } from './AssetRecordPanel';
import { BookingPanel } from './BookingPanel';

export type ActionMode = 'relocate' | 'staff' | 'parts';

const periodOrder = ['previous_period', 'current_period', 'next_period'] as const;
const periodLabels = { previous_period: 'Previous period', current_period: 'Current period', next_period: 'Next period' };
const actionRoles: Record<ActionMode, Role[]> = {
  relocate: ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'],
  staff: ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'],
  parts: ['MAINTENANCE_TECHNICIAN', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'],
};

function PeriodCardView({ card, label, active }: { card: PeriodCard | null; label: string; active: boolean }) {
  return <div className={cx('rounded-xl border p-3', active ? 'border-[#bbbcb3] bg-white shadow-sm' : 'border-stitch bg-silk/60')}>
    <div className="mb-3 flex items-center justify-between"><p className={cx('text-[9px] font-semibold uppercase tracking-[.16em]', active ? 'text-obsidian' : 'text-stone')}>{active && '● '}{label}</p>{card?.away_in_lab_code && <Badge tone="amber">Away in lab</Badge>}</div>
    {card ? <>
      <div className="flex items-baseline justify-between gap-2"><p className="mono text-xs font-semibold">P{card.period_number ?? '—'} <span className="font-normal text-stone">· {card.time_label}</span></p>{active && card.minutes_remaining !== undefined && <span className="mono text-[10px] text-cyan-800">{card.minutes_remaining}m left</span>}</div>
      <p className="mt-3 text-sm font-medium">{card.class_code ?? 'No scheduled class'}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-stone">{card.subject_title ?? card.location_status ?? 'Unoccupied period'}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone">
        {card.student_strength !== undefined && <span className="flex items-center gap-1"><UsersRound className="h-3 w-3" />{card.student_strength} / {card.room_capacity ?? 60}</span>}
        {card.faculty_name && <span className="flex items-center gap-1"><UserRound className="h-3 w-3" />{card.faculty_name}</span>}
      </div>
      {card.away_in_lab_code && <p className="mono mt-3 rounded-md bg-amber-50 px-2 py-1.5 text-[9px] text-amber-900">{card.away_in_lab_code}</p>}
      {card.is_relocated && <div className="mt-3 rounded-lg border border-cyan-200 bg-cyan-50 p-2 text-[10px] font-medium leading-4 text-cyan-900">RELOCATED {card.relocated_to_code ? `TO ${card.relocated_to_code}` : card.relocated_from_code ? `FROM ${card.relocated_from_code}` : ''} <span className="font-normal">(Vacant Home Room)</span></div>}
    </> : <p className="py-5 text-xs text-stone">Outside the academic schedule</p>}
  </div>;
}

function AssetIcon({ asset }: { asset: Asset }) {
  if (asset.asset_type.includes('FAN')) return <Fan className="h-4 w-4" />;
  if (asset.asset_type.includes('LED') || asset.asset_type.includes('LIGHT')) return <Lightbulb className="h-4 w-4" />;
  if (asset.asset_type.includes('BOARD')) return <PanelTop className="h-4 w-4" />;
  if (asset.asset_type.includes('BOT')) return <Bot className="h-4 w-4" />;
  return <Cpu className="h-4 w-4" />;
}

export function SpaceInspectorDrawer({ code, onClose, onAction }: {
  code: string;
  onClose: () => void;
  onAction: (mode: ActionMode, detail: SpaceDetail) => void;
}) {
  const { user } = useAuthStore();
  const { twinRevision, invalidateTwin } = usePortalStore();
  const [detail, setDetail] = useState<SpaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<number | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [completing, setCompleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setDetail(await api.twin.space(code)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load space'); }
    finally { setLoading(false); }
  }, [code]);
  useEffect(() => { void load(); }, [load, twinRevision]);

  const complete = async () => {
    if (!detail?.active_work_order || resolutionNotes.trim().length < 10) return;
    setCompleting(true); setError(null);
    try {
      await api.operations.complete(detail.active_work_order.id, resolutionNotes.trim());
      setCompleteOpen(false); setResolutionNotes('');
      invalidateTwin('Repair completed; authoritative twin state refreshed');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Completion failed'); }
    finally { setCompleting(false); }
  };

  const canComplete = user && (['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'].includes(user.role) || (user.role === 'MAINTENANCE_TECHNICIAN' && detail?.active_work_order?.assigned_staff_code === user.staff_code));
  const timelineSelection = detail?.full_day_timeline.find((period) => period.period_number === selectedPeriod);
  // Canteens and bill bots are always-open facilities; a class-period view is meaningless for them.
  const isAlwaysOpen = detail?.kind === 'CANTEEN' || detail?.kind === 'BILL_BOT';
  // A class can only be relocated when the room is actually faulty AND something is in session there.
  const canRelocate = Boolean(
    detail &&
    detail.visual_state !== 'HEALTHY' &&
    (detail.period_cards?.current_period?.class_code || detail.active_complaints.length > 0),
  );

  return <aside className="cloth-panel scrollbar-thin absolute inset-y-3 right-3 z-30 w-[min(560px,calc(100%-24px))] animate-slide-in overflow-y-auto rounded-2xl">
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stitch bg-linen/90 px-5 py-4 backdrop-blur-xl"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.18em] text-stone"><Box className="h-3.5 w-3.5" /> Space inspector</div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close inspector"><X className="h-4 w-4" /></Button></div>
    <div className="p-5">
      {loading && !detail ? <Spinner label="Resolving live space context" /> : error && !detail ? <ErrorBanner message={error} onRetry={() => void load()} /> : detail && <div className="space-y-6">
        {error && <ErrorBanner message={error} />}
        <section>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h2 className="mono text-2xl font-semibold tracking-tight">{detail.code}</h2>{detail.alias_code && <span className="mono rounded bg-silk px-2 py-1 text-[9px] text-stone">alias {detail.alias_code}</span>}</div><p className="mt-2 text-xs text-stone">{detail.name ?? `${detail.block ? `Block ${detail.block}` : detail.kind} ${detail.floor ? `· Floor ${detail.floor}` : ''}`}</p></div><StatusBadge status={detail.visual_state} /></div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-lg border border-stitch bg-white p-3"><p className="text-[9px] uppercase tracking-wider text-stone">Distribution board</p><p className="mono mt-1.5">{detail.distribution_board_code ?? 'Not applicable'}</p></div>
            <div className="rounded-lg border border-stitch bg-white p-3"><p className="text-[9px] uppercase tracking-wider text-stone">Home class</p><p className="mt-1.5 font-medium">{detail.home_class_code ?? 'Shared facility'}{detail.home_student_count !== undefined && <span className="text-stone"> · {detail.home_student_count} students</span>}</p></div>
          </div>
          {detail.active_lock && <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900"><LockKeyhole className="h-4 w-4" />Locked by {detail.active_lock.locked_by_name} · expires in {detail.active_lock.expires_in_seconds}s</div>}
        </section>

        {!isAlwaysOpen && <section><div className="mb-3 flex items-center gap-2"><Clock3 className="h-4 w-4" /><h3 className="text-xs font-semibold uppercase tracking-[.12em]">Live period context</h3></div><div className="grid gap-2 sm:grid-cols-3">{periodOrder.map((key) => <PeriodCardView key={key} card={detail.period_cards[key]} label={periodLabels[key]} active={key === 'current_period'} />)}</div></section>}

        {!isAlwaysOpen && <section><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[.12em]">Today's six-period timeline</h3><span className="text-[10px] text-stone">Select a slot for detail</span></div>
          <div className="grid grid-cols-6 gap-1.5">{detail.full_day_timeline.map((period, index) => <button key={`${period.period_number}-${index}`} onClick={() => setSelectedPeriod(period.period_number)} className={cx('min-w-0 rounded-lg border p-2 text-left transition', selectedPeriod === period.period_number ? 'border-obsidian bg-obsidian text-white' : period.away_in_lab_code ? 'border-amber-200 bg-amber-50' : 'border-stitch bg-white hover:border-stone-400')}><p className="mono text-[10px] font-semibold">P{period.period_number ?? index + 1}</p><p className="mt-2 truncate text-[9px]">{period.away_in_lab_code ?? period.class_code ?? 'Open'}</p><div className={cx('mt-2 h-1 rounded-full', period.is_relocated ? 'bg-cyan-500' : period.away_in_lab_code ? 'bg-amber-400' : 'bg-emerald-400')} /></button>)}</div>
          {timelineSelection && <div className="mt-2 rounded-lg border border-stitch bg-silk p-3 text-[11px] leading-5"><span className="mono font-medium">P{timelineSelection.period_number}</span> · {timelineSelection.subject_title ?? 'No session'}<br /><span className="text-stone">{timelineSelection.class_code ?? 'Unoccupied'} {timelineSelection.faculty_name ? `· ${timelineSelection.faculty_name}` : ''} {timelineSelection.away_in_lab_code ? `· ${timelineSelection.away_in_lab_code}` : ''}</span></div>}
        </section>}

        <BookingPanel
          code={detail.code}
          kind={detail.kind}
          visualState={detail.visual_state}
          onChanged={() => invalidateTwin('Room booking updated; calendar and twin refreshed')}
        />

        <section><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[.12em]">{detail.kind === 'CLASSROOM' ? 'Live 22-asset twin' : 'Equipment digital twin'}</h3><Badge tone={detail.assets.some((asset) => asset.status === 'FAULTY') ? 'red' : 'green'}>{detail.assets.length} assets</Badge></div>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">{detail.assets.sort((a, b) => a.slot_index - b.slot_index).map((asset) => <button key={asset.asset_code} onClick={() => setSelectedAsset((current) => current === asset.asset_code ? null : asset.asset_code)} aria-pressed={selectedAsset === asset.asset_code} title={`${asset.name ?? asset.asset_code} · ${asset.asset_code}`} className={cx('flex min-h-[68px] flex-col items-center justify-center rounded-lg border p-1.5 transition', asset.status === 'FAULTY' ? 'fault-pulse border-red-200 bg-red-50 text-red-800' : asset.status === 'DEGRADED' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-100 bg-white text-emerald-800 hover:border-emerald-300', selectedAsset === asset.asset_code && 'ring-2 ring-obsidian ring-offset-1')}><AssetIcon asset={asset} /><span className="mono mt-1.5 max-w-full truncate text-[8px]">{assetShortLabel(asset)}</span>{asset.paper_percent !== undefined && <span className="text-[8px]">{asset.paper_percent}%</span>}</button>)}</div>
          <p className="mt-2 text-[10px] text-stone">Select any asset to open its full service record, previous repairs and cost history.</p>
          {selectedAsset && <div className="mt-3"><AssetRecordPanel key={selectedAsset} assetCode={selectedAsset} onClose={() => setSelectedAsset(null)} /></div>}
        </section>

        <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-[.12em]">Complaints & incident intelligence</h3>
          {detail.active_complaints.length === 0 ? <div className="rounded-xl border border-stitch bg-white p-4 text-xs text-stone">No active complaints for this space.</div> : <div className="space-y-2">{detail.active_complaints.map((complaint) => <article key={complaint.id} className="rounded-xl border border-stitch bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="mono text-[11px] font-semibold">{complaint.ticket_number}</span><div className="flex gap-1.5"><StatusBadge status={complaint.urgency} /><Badge tone={complaint.is_anonymous ? 'violet' : 'neutral'}>{complaint.is_anonymous ? 'Anonymous' : 'Named'}</Badge></div></div><p className="mt-3 text-xs leading-5 text-stone">{complaint.description}</p>
            {complaint.photo_url && <a href={complaint.photo_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-medium underline"><FileText className="h-3 w-3" />View photo evidence</a>}
            <div className="mt-3 flex items-center gap-3 border-t border-stitch pt-3 text-[10px] text-stone"><span>{complaint.public_reporter_label}</span><span>{complaint.affected_upvote_count} affected</span><span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" />{complaint.comments?.length ?? 0}</span></div>
            {complaint.comments && complaint.comments.length > 0 && <div className="mt-2 space-y-1.5">{complaint.comments.map((comment) => <div key={comment.id} className="rounded-md bg-silk p-2 text-[10px]"><p>{comment.body}</p><p className="mt-1 text-stone">{comment.public_author_label}</p></div>)}</div>}
          </article>)}</div>}
          {detail.correlated_incident && <div className="mt-3 rounded-xl border border-cyan-200 bg-cyan-50/60 p-4"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-cyan-900"><GitCorrelationIcon />{detail.correlated_incident.correlation_type.replaceAll('_', ' ')}</div><p className="mt-2 text-xs leading-5 text-cyan-950">{detail.correlated_incident.ai_summary_text}</p>{detail.correlated_incident.root_cause && <p className="mono mt-2 text-[10px] text-cyan-800">Root cause · {detail.correlated_incident.root_cause}</p>}</div>}
          {detail.sla_clock && detail.active_complaints.length > 0 && <div className="mt-3 rounded-xl border border-stitch bg-white p-4"><div className="flex items-center justify-between text-xs"><span className="font-medium">SLA response clock</span><span className="mono">{detail.sla_clock.is_paused ? 'PAUSED' : `${Math.max(0, detail.sla_clock.remaining_minutes)}m left`}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-silk"><div className={cx('h-full rounded-full', detail.sla_clock.is_paused ? 'bg-purple-500' : detail.sla_clock.breach_state === 'BREACHED_100' ? 'bg-red-500' : detail.sla_clock.breach_state === 'WARNING_75' ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, detail.sla_clock.progress_percent)}%` }} /></div>{detail.sla_clock.is_paused && <p className="mt-2 text-[10px] font-medium text-purple-800">PAUSED — {detail.sla_clock.pause_reason ?? 'AWAITING PARTS'}</p>}</div>}
        </section>

        {detail.maintenance_history.length > 0 && <details className="rounded-xl border border-stitch bg-white p-4"><summary className="cursor-pointer text-xs font-medium">Maintenance history · {detail.maintenance_history.length}</summary><div className="mt-3 space-y-3">{detail.maintenance_history.map((record) => <div key={record.id} className="border-l border-stitch pl-3 text-[11px]"><p>{record.action}</p><p className="mt-1 text-stone">{record.asset_code ?? record.asset_type} · {record.technician_name ?? 'Maintenance'} · {formatDate(record.completed_at)}</p></div>)}</div></details>}

        <section className="pb-4"><div className="mb-3 flex items-center gap-2"><ShieldCheck className="h-4 w-4" /><h3 className="text-xs font-semibold uppercase tracking-[.12em]">Operational actions</h3></div><div className="grid gap-2 sm:grid-cols-2">
          {user && actionRoles.relocate.includes(user.role) && <Button variant="secondary" className="justify-start" disabled={!canRelocate} title={canRelocate ? 'Relocate the class currently scheduled here' : 'Relocation needs a faulty room with a class in session'} onClick={() => onAction('relocate', detail)}><ArrowLeftRight className="h-4 w-4" />Relocate affected class</Button>}
          {user && actionRoles.staff.includes(user.role) && <Button variant="secondary" className="justify-start" disabled={!detail.active_work_order} title={detail.active_work_order ? 'Assign a technician to the active work order' : 'Needs an active work order'} onClick={() => onAction('staff', detail)}><Wrench className="h-4 w-4" />Claim & assign technician</Button>}
          {user && actionRoles.parts.includes(user.role) && <Button variant="secondary" className="justify-start" disabled={!detail.active_work_order} title={detail.active_work_order ? 'Reserve parts for the active work order' : 'Needs an active work order'} onClick={() => onAction('parts', detail)}><PackageCheck className="h-4 w-4" />Reserve spare parts</Button>}
          {canComplete && <Button className="justify-start" disabled={!detail.active_work_order} title={detail.active_work_order ? 'Record the verified repair' : 'Needs an active work order'} onClick={() => setCompleteOpen(true)}><CheckCircle2 className="h-4 w-4" />Complete & restore healthy</Button>}
        </div>{!detail.active_work_order && <p className="mt-2 text-[10px] text-stone">Technician, parts and completion actions become available when an active work order exists.</p>}</section>
      </div>}
    </div>
    <Modal open={completeOpen} onClose={() => setCompleteOpen(false)} title="Complete repair & restore space" description={detail?.active_work_order ? `${detail.active_work_order.work_order_number} · ${detail.code}` : undefined}>
      <div className="space-y-4"><div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-900">The backend will verify the active work order, record resolution, restore affected assets and broadcast the healthy twin state.</div><label className="block text-xs font-medium">Resolution notes<textarea value={resolutionNotes} onChange={(event) => setResolutionNotes(event.target.value)} minLength={10} rows={4} className="mt-2 w-full rounded-xl border border-stitch bg-white p-3 text-sm outline-none focus:border-stone-400" placeholder="Describe the verified repair and restored equipment…" /></label><Button className="w-full" disabled={completing || resolutionNotes.trim().length < 10} onClick={() => void complete()}>{completing ? 'Submitting verified resolution…' : 'Mark repair complete'}<ChevronRight className="h-4 w-4" /></Button></div>
    </Modal>
  </aside>;
}

function GitCorrelationIcon() {
  return <RotateCcw className="h-3.5 w-3.5" />;
}
