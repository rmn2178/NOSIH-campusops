import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Building2, Clock3, Expand, FlaskConical, Layers3, RefreshCw, Search, UtensilsCrossed } from 'lucide-react';
import { api } from '../api/client';
import { SpaceInspectorDrawer, type ActionMode } from '../components/twin3d/SpaceInspectorDrawer';
import { CampusCanvas3D } from '../components/twin3d/CampusCanvas3D';
import { campusNodeCount } from '../components/twin3d/campusLayout';
import { UnavailableResourcesModal } from '../components/modals/UnavailableResourcesModal';
import { Badge, Button, ErrorBanner } from '../components/ui';
import { usePortalStore } from '../store/portalStore';
import type { SpaceDetail } from '../types';

const periodStarts = ['09:00', '09:50', '10:55', '11:45', '13:20', '14:10'];
const days = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const;

export function TwinWorkspace() {
  const {
    overview, setOverview, selectedSpaceCode, selectSpace, floorExplode, setFloorExplode,
    clock, setClock, twinRevision, invalidateTwin, overviewLoadedAt,
  } = usePortalStore();
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [draftTime, setDraftTime] = useState('09:00');
  const [clockSaving, setClockSaving] = useState(false);
  const [action, setAction] = useState<{ mode: ActionMode; detail: SpaceDetail } | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true); setError(null);
    try {
      const [twin, campusClock] = await Promise.all([api.twin.overview(), api.clock.get()]);
      setOverview(twin.spaces);
      setClock(campusClock);
      setDraftTime(campusClock.current_time.slice(0, 5));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load campus twin'); }
    finally { setRefreshing(false); }
  }, [setClock, setOverview]);
  useEffect(() => { void load(); }, [load, twinRevision]);
  useEffect(() => { if (clock) setDraftTime(clock.current_time.slice(0, 5)); }, [clock]);

  const updateClock = async (payload: { day_of_week?: typeof days[number]; current_time?: string }) => {
    setClockSaving(true); setError(null);
    try { setClock(await api.clock.update(payload)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Campus clock update rejected'); }
    finally { setClockSaving(false); }
  };
  const selectSearch = () => {
    const upper = search.trim().toUpperCase();
    const alias = upper.match(/^([ABC])0-(\d{2})$/);
    const code = alias ? `${alias[1]}1-${alias[2]}` : upper;
    if (Object.keys(overview).length === 0 || overview[code] || /^[ABC][1-7]-0[1-6]$/.test(code) || code.startsWith('LAB-') || code.startsWith('CAN-') || code.startsWith('BOT-')) selectSpace(code);
    else setError(`Space “${search}” was not found in the campus overview.`);
  };
  const counts = useMemo(() => {
    const spaces = Object.values(overview);
    return {
      rooms: spaces.filter((space) => space.kind === 'CLASSROOM').length,
      labs: spaces.filter((space) => space.kind === 'LAB').length,
      facilities: spaces.filter((space) => space.kind === 'CANTEEN' || space.kind === 'BILL_BOT').length,
      faults: spaces.filter((space) => space.visual_state !== 'HEALTHY').length,
    };
  }, [overview]);

  return <div className="relative h-full overflow-hidden bg-[#F5F4F0]">
    <CampusCanvas3D overview={overview} selectedCode={selectedSpaceCode} explode={floorExplode} onSelect={selectSpace} />
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-4">
      <section className="cloth-panel pointer-events-auto w-[310px] rounded-2xl p-4">
        <div className="flex items-start justify-between"><div><p className="text-[9px] font-semibold uppercase tracking-[.2em] text-stone">Live campus model</p><h1 className="mt-1.5 text-xl font-semibold tracking-[-.035em]">Architectural twin</h1></div><Button size="icon" variant="ghost" onClick={() => void load()} title="Refresh authoritative twin state"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></Button></div>
        <div className="mt-4 grid grid-cols-4 gap-2">{[
          [Building2, counts.rooms || 90, 'Rooms'], [FlaskConical, counts.labs || 20, 'Labs'], [UtensilsCrossed, counts.facilities || 13, 'Facilities'], [Box, counts.faults, 'Faults'],
        ].map(([Icon, value, label]) => {
          const IconComponent = Icon as typeof Building2;
          return <div key={String(label)} className="border-l border-stitch pl-2 first:border-0 first:pl-0"><IconComponent className="mb-2 h-3.5 w-3.5 text-stone" /><p className="mono text-sm font-medium">{String(value).padStart(2, '0')}</p><p className="mt-0.5 text-[8px] uppercase tracking-wider text-stone">{String(label)}</p></div>;
        })}</div>
        <form className="relative mt-4" onSubmit={(event) => { event.preventDefault(); selectSearch(); }}><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-stone" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find C4-03, LAB-OOPS-01…" className="h-9 w-full rounded-lg border border-stitch bg-white pl-9 pr-3 text-[11px] outline-none focus:border-stone-400" /></form>
        <p className="mt-2 text-[9px] text-stone">{campusNodeCount} interactive spaces {overviewLoadedAt ? `· synced ${new Date(overviewLoadedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '· awaiting live state'}</p>
      </section>

      {!selectedSpaceCode && <section className="cloth-panel pointer-events-auto hidden w-[300px] rounded-2xl p-4 md:block">
        <div className="mb-3 flex items-center gap-2"><Clock3 className="h-4 w-4" /><p className="text-[10px] font-semibold uppercase tracking-[.14em]">Campus period clock</p></div>
        <div className="flex gap-2"><select aria-label="Campus day" disabled={clockSaving} value={clock?.day_of_week ?? 'MON'} onChange={(event) => void updateClock({ day_of_week: event.target.value as typeof days[number] })} className="h-9 rounded-lg border border-stitch bg-white px-2 text-xs">{days.map((day) => <option key={day}>{day}</option>)}</select><input aria-label="Campus time" type="time" min="09:00" max="15:00" step="60" disabled={clockSaving} value={draftTime} onChange={(event) => setDraftTime(event.target.value)} onBlur={() => { if (draftTime !== clock?.current_time.slice(0, 5)) void updateClock({ current_time: draftTime }); }} onKeyDown={(event) => { if (event.key === 'Enter') void updateClock({ current_time: draftTime }); }} className="mono h-9 min-w-0 flex-1 rounded-lg border border-stitch bg-white px-2 text-xs" /></div>
        <div className="mt-3 grid grid-cols-6 gap-1">{periodStarts.map((time, index) => <button key={time} disabled={clockSaving} onClick={() => void updateClock({ current_time: time })} className={`rounded-md border py-2 text-[9px] font-medium transition ${clock?.active_period === index + 1 ? 'border-obsidian bg-obsidian text-white' : 'border-stitch bg-white hover:border-stone-400'}`}>P{index + 1}</button>)}</div>
        <label className="mt-4 block"><span className="flex items-center justify-between text-[9px] uppercase tracking-wider text-stone"><span>Time-of-day scrubber</span><span className="mono">{draftTime}</span></span><input className="mt-2 w-full" type="range" min="540" max="900" step="1" value={Number(draftTime.slice(0, 2)) * 60 + Number(draftTime.slice(3, 5))} onChange={(event) => { const minutes = Number(event.target.value); setDraftTime(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`); }} onPointerUp={() => void updateClock({ current_time: draftTime })} onKeyUp={() => void updateClock({ current_time: draftTime })} /></label>
      </section>}
    </div>

    <section className="cloth-panel absolute bottom-4 left-4 z-20 w-[310px] rounded-2xl p-4">
      <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Layers3 className="h-4 w-4" /><p className="text-[10px] font-semibold uppercase tracking-[.14em]">Floor separation</p></div><span className="mono text-[10px]">{floorExplode.toFixed(2)}×</span></div>
      <div className="mt-3 flex items-center gap-3"><Expand className="h-3.5 w-3.5 rotate-90 text-stone" /><input aria-label="Explode building floors" type="range" min="0" max="3.5" step="0.05" value={floorExplode} onChange={(event) => setFloorExplode(Number(event.target.value))} className="w-full" /></div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2 border-t border-stitch pt-3">{[['Healthy', '#4ADE80'], ['Manageable', '#FB923C'], ['Major', '#F87171'], ['Parts hold', '#A855F7']].map(([label, color]) => <span key={label} className="flex items-center gap-1.5 text-[9px] text-stone"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />{label}</span>)}</div>
    </section>

    <div className="pointer-events-none absolute bottom-5 right-5 z-20 mr-0"><Badge tone="neutral" className="bg-white/80">Drag to orbit · Scroll to zoom · Click a space to inspect</Badge></div>
    {error && <div className="absolute left-1/2 top-4 z-40 w-[min(520px,calc(100%-32px))] -translate-x-1/2"><ErrorBanner message={error} onRetry={() => void load()} /></div>}
    {selectedSpaceCode && <SpaceInspectorDrawer code={selectedSpaceCode} onClose={() => selectSpace(null)} onAction={(mode, detail) => setAction({ mode, detail })} />}
    {action && <UnavailableResourcesModal open onClose={() => setAction(null)} mode={action.mode} spaceCode={action.detail.code} workOrder={action.detail.active_work_order} onCompleted={() => { invalidateTwin('Operation committed; live campus state synchronized'); setAction(null); }} />}
  </div>;
}
