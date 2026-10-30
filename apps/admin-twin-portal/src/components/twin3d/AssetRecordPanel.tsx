import { useCallback, useEffect, useState } from 'react';
import {
  Activity, CalendarDays, CheckCircle2, Cpu, Download, History, IndianRupee,
  Package, Timer, UserRound, Wrench, X,
} from 'lucide-react';
import { api } from '../../api/client';
import type { AssetHistory } from '../../types';
import { Badge, ErrorBanner, Spinner, StatusBadge, cx, formatDate, formatINR } from '../ui';

const healthTone = {
  CRITICAL: 'red',
  WATCH: 'amber',
  SERVICED: 'cyan',
  STABLE: 'green',
} as const;

function duration(minutes: number) {
  if (!minutes) return '0m';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

function dateOnly(value?: string | null) {
  return value
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value))
    : '—';
}

const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export function AssetRecordPanel({ assetCode, onClose }: { assetCode: string; onClose: () => void }) {
  const [record, setRecord] = useState<AssetHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRecord(await api.twin.assetHistory(assetCode));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load asset record');
    } finally {
      setLoading(false);
    }
  }, [assetCode]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !record) {
    return <div className="rounded-2xl border border-stitch bg-white"><Spinner label="Opening asset service record" /></div>;
  }

  if (error && !record) {
    return <div className="rounded-2xl border border-stitch bg-white p-3"><ErrorBanner message={error} onRetry={() => void load()} /></div>;
  }

  if (!record) return null;
  const { asset, stats, current_work_order: current, history, parts_summary: parts } = record;
  const tone = healthTone[stats.health_label] ?? 'neutral';
  const partsShare = stats.total_cost_inr > 0 ? (stats.total_parts_cost_inr / stats.total_cost_inr) * 100 : 0;

  const exportCsv = () => {
    const rows = [
      ['Asset', asset.asset_code, asset.name, asset.space_code],
      ['Repairs', stats.repair_count, 'Total cost INR', stats.total_cost_inr, 'Downtime minutes', stats.total_downtime_mins],
      [],
      ['Completed', 'Work order', 'Fault', 'Action', 'Technician', 'Downtime (m)', 'Parts INR', 'Labour INR', 'Total INR', 'Parts used', 'Complaint'],
      ...history.map((repair) => [
        repair.completed_at, repair.work_order_number, repair.fault_category, repair.action,
        repair.technician_name, repair.downtime_mins, repair.parts_cost_inr, repair.labour_cost_inr,
        repair.total_cost_inr, repair.parts.map((part) => `${part.name} x${part.qty}`).join('; '),
        repair.complaint_ticket,
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = `${asset.asset_code}-service-history.csv`;
    link.click();
    URL.revokeObjectURL(href);
  };

  return <article className="overflow-hidden rounded-2xl border border-stitch bg-white shadow-cloth">
    <header className="bg-obsidian px-4 py-3.5 text-white">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-[#B9B3A7]" />
            <h4 className="truncate text-sm font-semibold">{asset.name}</h4>
          </div>
          <p className="mono mt-1 text-[10px] tracking-wide text-[#B9B3A7]">{asset.asset_code} · {asset.asset_type.replaceAll('_', ' ')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={asset.status} />
          <button onClick={exportCsv} aria-label="Download service history as CSV" className="rounded-md p-1 text-[#B9B3A7] transition hover:bg-white/10 hover:text-white"><Download className="h-3.5 w-3.5" /></button>
          <button onClick={onClose} aria-label="Close asset record" className="rounded-md p-1 text-[#B9B3A7] transition hover:bg-white/10 hover:text-white"><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#B9B3A7]">
        <span className="flex items-center gap-1"><CalendarDays className="h-3 w-3" />{dateOnly(asset.installed_at)}{asset.age_days != null ? ` · ${Math.floor(asset.age_days / 365)}y ${Math.floor((asset.age_days % 365) / 30)}m old` : ''}</span>
        <span className="mono">{asset.sku_code ?? 'No spare SKU'}</span>
      </div>
    </header>

    {error && <div className="p-3"><ErrorBanner message={error} onRetry={() => void load()} /></div>}

    <div className="grid grid-cols-2 gap-px bg-stitch sm:grid-cols-4">
      {[
        { label: 'Repairs', value: String(stats.repair_count), icon: Wrench },
        { label: 'Lifetime cost', value: formatINR(stats.total_cost_inr), icon: IndianRupee },
        { label: 'Downtime', value: duration(stats.total_downtime_mins), icon: Timer },
        { label: 'Health', value: `${stats.health_score}/100`, icon: Activity },
      ].map(({ label, value, icon: Icon }) => <div key={label} className="bg-white px-3 py-3"><div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-stone"><Icon className="h-3 w-3" />{label}</div><p className="mono mt-1.5 text-sm font-semibold">{value}</p></div>)}
    </div>

    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-stitch bg-silk/60 p-3">
        <div className="flex items-center justify-between"><p className="text-[9px] font-semibold uppercase tracking-[.14em] text-stone">Asset health</p><Badge tone={tone}>{stats.health_label}</Badge></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white"><div className={cx('h-full rounded-full', stats.health_score >= 70 ? 'bg-emerald-500' : stats.health_score >= 40 ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${Math.min(100, Math.max(3, stats.health_score))}%` }} /></div>
        <div className="mt-2 flex items-center justify-between text-[10px] text-stone"><span>{asset.failure_count_30d} failure{asset.failure_count_30d === 1 ? '' : 's'} in 30 days</span><span>{stats.last_repair_at ? `Last serviced ${dateOnly(stats.last_repair_at)}` : 'No service record'}</span></div>
        <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-white"><div className="h-full bg-[#B23B24]" style={{ width: `${partsShare}%` }} /><div className="h-full flex-1 bg-[#245A54]" /></div>
        <div className="mt-1.5 flex items-center justify-between text-[9px] text-stone"><span><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[#B23B24]" />Parts {formatINR(stats.total_parts_cost_inr)}</span><span><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[#245A54]" />Labour {formatINR(stats.total_labour_cost_inr)}</span></div>
      </div>

      {current && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950">
        <div className="flex items-center justify-between gap-2"><p className="text-[9px] font-semibold uppercase tracking-[.14em] text-amber-800">Open work order</p><StatusBadge status={current.status} /></div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className="mono text-xs font-semibold">{current.wo_number}</span><span className="text-[11px]">{current.complaint_ticket ? `${current.complaint_ticket} · ${current.complaint_title ?? 'Linked complaint'}` : 'No linked complaint'}</span></div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-amber-900"><span className="flex items-center gap-1"><UserRound className="h-3 w-3" />{current.technician_name ?? 'Awaiting assignment'}</span><span>Open {duration(current.age_minutes)}</span>{current.priority_score !== undefined && <span className="mono">Priority {current.priority_score.toFixed(1)}</span>}</div>
      </div>}

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-lg border border-stitch p-3"><p className="text-[9px] uppercase tracking-wider text-stone">Space</p><p className="mono mt-1.5">{asset.space_code}</p><p className="mt-0.5 text-[10px] text-stone">{asset.space_name ?? asset.space_kind?.replaceAll('_', ' ') ?? 'Campus asset'}{asset.block ? ` · Block ${asset.block}` : ''}{asset.floor !== undefined ? ` · Floor ${asset.floor}` : ''}</p></div>
        <div className="rounded-lg border border-stitch p-3"><p className="text-[9px] uppercase tracking-wider text-stone">Service profile</p><p className="mt-1.5">{stats.avg_downtime_mins}m average downtime</p><p className="mt-0.5 text-[10px] text-stone">{stats.days_since_last_repair === null ? 'First recorded service pending' : `${stats.days_since_last_repair} days since last repair`}</p></div>
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between"><h5 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.14em]"><History className="h-3.5 w-3.5" />Previous repairs</h5><Badge tone="neutral">{history.length} records</Badge></div>
        {history.length === 0 ? <div className="rounded-xl border border-stitch bg-white p-4 text-[11px] leading-5 text-stone">No repair has been recorded for this asset since installation. Costs and downtime will appear here after the first closed work order.</div> : <div className="space-y-2">{history.map((repair) => <article key={repair.id} className="rounded-xl border border-stitch bg-white p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="mono text-[10px] font-semibold">{repair.work_order_number ?? 'Maintenance record'}</p><p className="mt-0.5 text-[9px] uppercase tracking-wider text-stone">{formatDate(repair.completed_at)}</p></div>
            <div className="text-right"><p className="mono text-xs font-semibold">{formatINR(repair.total_cost_inr)}</p><p className="text-[9px] text-stone">{duration(repair.downtime_mins)} downtime</p></div>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-obsidian">{repair.action}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone">
            <span className="flex items-center gap-1"><UserRound className="h-3 w-3" />{repair.technician_name ?? repair.technician_code ?? 'Maintenance'}</span>
            {repair.fault_category && <span className="mono">{repair.fault_category.replaceAll('_', ' ')}</span>}
            {repair.complaint_ticket && <span className="mono">{repair.complaint_ticket}</span>}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
            <span className="rounded-md bg-silk px-2 py-1 text-stone">Parts <span className="mono float-right text-obsidian">{formatINR(repair.parts_cost_inr)}</span></span>
            <span className="rounded-md bg-silk px-2 py-1 text-stone">Labour <span className="mono float-right text-obsidian">{formatINR(repair.labour_cost_inr)}</span></span>
          </div>
          {repair.parts.length > 0 && <div className="mt-2 space-y-1">{repair.parts.map((part) => <div key={`${repair.id}-${part.sku_code}`} className="flex items-center justify-between rounded-md border border-stitch px-2 py-1 text-[10px]"><span className="flex items-center gap-1.5"><Package className="h-3 w-3 text-stone" />{part.name} <span className="mono text-stone">×{part.qty}</span></span><span className="mono">{formatINR(part.qty * part.unit_cost_inr)}</span></div>)}</div>}
        </article>)}</div>}
      </section>

      {parts.length > 0 && <section>
        <h5 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.14em]"><Package className="h-3.5 w-3.5" />Parts consumed</h5>
        <div className="overflow-hidden rounded-xl border border-stitch">
          <div className="grid grid-cols-[1fr_44px_84px] gap-2 bg-silk px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-stone"><span>Part</span><span className="text-right">Qty</span><span className="text-right">Spend</span></div>
          {parts.map((part) => <div key={part.sku_code} className="grid grid-cols-[1fr_44px_84px] items-center gap-2 border-t border-stitch px-3 py-2 text-[10px]"><span className="truncate">{part.name}<span className="mono ml-1 text-stone">{part.sku_code}</span></span><span className="mono text-right">{part.quantity}</span><span className="mono text-right">{formatINR(part.spend_inr)}</span></div>)}
        </div>
      </section>}

      <div className="flex items-center gap-1.5 border-t border-stitch pt-3 text-[9px] uppercase tracking-wider text-stone"><CheckCircle2 className="h-3 w-3 text-emerald-600" />Cost = parts consumed + technician labour at the recorded hourly rate</div>
    </div>
  </article>;
}
