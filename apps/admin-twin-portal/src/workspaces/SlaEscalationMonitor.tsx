import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowUp, BellRing, Clock3, Pause, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, EmptyState, ErrorBanner, PageHeader, Panel, Spinner, StatusBadge, cx, formatDate } from '../components/ui';
import { usePortalStore } from '../store/portalStore';
import type { SlaClock } from '../types';

const tiers = ['Maintenance', 'Incident Manager', 'Facilities Admin', 'Principal Office'];
const filters = ['ALL', 'WARNING_75', 'BREACHED_100', 'PAUSED'];

export function SlaEscalationMonitor() {
  const { twinRevision } = usePortalStore();
  const [clocks, setClocks] = useState<SlaClock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setClocks(await api.sla.list()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load SLA clocks'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { setLoading(true); void load(); }, [load, twinRevision]);
  useEffect(() => { const interval = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(interval); }, [load]);
  const activeClocks = useMemo(() => clocks.filter((clock) => !clock.is_closed), [clocks]);
  const filtered = useMemo(() => activeClocks.filter((clock) => filter === 'ALL' || (filter === 'PAUSED' ? clock.is_paused : clock.breach_state === filter)), [activeClocks, filter]);
  const selected = activeClocks.find((clock) => clock.id === selectedId) ?? filtered[0];
  const chartData = filtered.slice(0, 12).map((clock) => ({ name: clock.work_order_number ?? clock.space_code ?? clock.id.slice(0, 8), elapsed: Math.min(100, Math.round(clock.progress_percent)), state: clock.breach_state }));

  return <><PageHeader eyebrow="Workspace 04 · Time-based accountability" title="SLA & escalation command" description="Active response time excludes parts pauses. Warning and breach thresholds dispatch verified notifications through the four-tier escalation chain." actions={<Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>} />
    {error && <div className="mb-5"><ErrorBanner message={error} onRetry={() => void load()} /></div>}
    {loading && clocks.length === 0 ? <Spinner label="Loading active SLA clocks" /> : <>
      <div className="mb-5 grid gap-3 sm:grid-cols-4">{[
        ['Active clocks', activeClocks.length, Clock3, 'neutral'], ['75% warnings', activeClocks.filter((clock) => clock.breach_state === 'WARNING_75').length, BellRing, 'amber'],
        ['100% breached', activeClocks.filter((clock) => clock.breach_state === 'BREACHED_100').length, AlertTriangle, 'red'], ['Paused for parts', activeClocks.filter((clock) => clock.is_paused).length, Pause, 'violet'],
      ].map(([label, value, Icon, tone]) => { const IconComponent = Icon as typeof Clock3; return <Panel key={String(label)} className="p-4"><div className="flex items-center justify-between"><IconComponent className="h-4 w-4 text-stone" /><Badge tone={tone as 'neutral'}>{String(value)}</Badge></div><p className="mt-4 text-xs font-medium">{String(label)}</p></Panel>; })}</div>
      <div className="mb-5 flex flex-wrap gap-1">{filters.map((item) => <button key={item} onClick={() => setFilter(item)} className={cx('rounded-lg px-3 py-2 text-[10px] font-medium', filter === item ? 'bg-obsidian text-white' : 'border border-stitch bg-white text-stone')}>{item.replaceAll('_', ' ')}</button>)}</div>
      <div className="grid items-start gap-5 xl:grid-cols-[1.1fr_.9fr]"><Panel className="overflow-hidden"><div className="border-b border-stitch p-5"><h2 className="text-sm font-semibold">Response clocks</h2><p className="mt-1 text-[11px] text-stone">Select a work order to inspect its escalation record</p></div>{filtered.length === 0 ? <EmptyState title="No clocks match this filter" description="Choose another state or wait for operational work to begin." /> : <div className="divide-y divide-stitch">{filtered.map((clock) => <button key={clock.id} onClick={() => setSelectedId(clock.id)} className={cx('block w-full p-5 text-left transition', selected?.id === clock.id ? 'bg-linen' : 'bg-white hover:bg-linen/50')}><div className="flex flex-wrap items-center justify-between gap-2"><div><span className="mono text-xs font-semibold">{clock.work_order_number ?? clock.work_order_id}</span><span className="mono ml-3 text-[10px] text-stone">{clock.space_code}</span></div><StatusBadge status={clock.is_paused ? 'PAUSED' : clock.breach_state} /></div><div className="mt-4 flex items-end justify-between"><div><p className="mono text-xl font-medium">{clock.is_paused ? 'PAUSED' : `${Math.max(0, clock.remaining_minutes)}m`}</p><p className="mt-1 text-[9px] uppercase tracking-wider text-stone">{clock.is_paused ? clock.pause_reason : 'Active time remaining'}</p></div><p className="mono text-xs text-stone">{Math.round(clock.progress_percent)}%</p></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-silk"><div className={cx('h-full rounded-full transition-all', clock.is_paused ? 'bg-purple-500' : clock.breach_state === 'BREACHED_100' ? 'bg-red-500' : clock.breach_state === 'WARNING_75' ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, clock.progress_percent)}%` }} /></div><div className="mt-3 flex items-center justify-between text-[9px] text-stone"><span>{clock.elapsed_active_minutes} / {clock.target_minutes} active minutes</span><span>Escalation tier {clock.current_escalation_tier}</span></div></button>)}</div>}</Panel>
        <div className="space-y-5">{chartData.length > 0 && <Panel className="p-5"><h2 className="text-sm font-semibold">SLA consumption</h2><p className="mt-1 text-[11px] text-stone">Percentage of target active minutes</p><div className="mt-4 h-60"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} layout="vertical" margin={{ left: 12, right: 12 }}><CartesianGrid horizontal={false} stroke="#ECE9E2" /><XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="name" width={86} tick={{ fontSize: 8, fill: '#63615C' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #E6E4DC', fontSize: 11 }} /><Bar dataKey="elapsed" radius={[0, 4, 4, 0]}>{chartData.map((entry) => <Cell key={entry.name} fill={entry.state === 'BREACHED_100' ? '#F87171' : entry.state === 'WARNING_75' ? '#F59E0B' : '#86EFAC'} />)}</Bar></BarChart></ResponsiveContainer></div></Panel>}
          {selected && <Panel className="p-5"><div className="flex items-center justify-between"><div><p className="text-[9px] uppercase tracking-wider text-stone">Escalation record</p><h2 className="mono mt-1 text-sm font-semibold">{selected.work_order_number ?? selected.work_order_id}</h2></div><Badge tone="neutral">Tier {selected.current_escalation_tier} / 4</Badge></div><div className="mt-5 space-y-0">{tiers.map((tier, index) => { const reached = selected.current_escalation_tier >= index + 1; return <div key={tier} className="relative flex gap-3 pb-5 last:pb-0">{index < tiers.length - 1 && <div className={cx('absolute left-[11px] top-6 h-full w-px', reached ? 'bg-obsidian' : 'bg-stitch')} />}<span className={cx('relative z-10 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border bg-white', reached ? 'border-obsidian text-obsidian' : 'border-stitch text-stone')}>{reached ? <ArrowUp className="h-3 w-3" /> : <span className="mono text-[8px]">{index + 1}</span>}</span><div><p className={cx('text-xs font-medium', !reached && 'text-stone')}>Tier {index + 1} · {tier}</p><p className="mt-1 text-[10px] text-stone">{reached ? 'Notification threshold reached' : 'Awaiting escalation threshold'}</p></div></div>; })}</div>
            {selected.escalation_log && selected.escalation_log.length > 0 && <div className="mt-5 border-t border-stitch pt-4"><p className="mb-3 text-[10px] font-semibold uppercase tracking-wider">Outbound escalation log</p>{selected.escalation_log.map((event, index) => <div key={event.id ?? index} className="mb-3 rounded-lg bg-silk p-3"><div className="flex justify-between text-[10px]"><span>{event.channel} · {event.recipient}</span><span>{formatDate(event.created_at)}</span></div><p className="mt-2 text-[11px] leading-5 text-stone">{event.message}</p></div>)}</div>}
          </Panel>}
        </div></div>
    </>}
  </>;
}
