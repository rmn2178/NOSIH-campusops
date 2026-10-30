import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, PackageX, RefreshCw, Repeat2, Wrench } from 'lucide-react';
import { supabase } from '@nosih/supabase-client';
import { Badge, Button, ErrorBanner, PageHeader, Panel, Spinner } from '../components/ui';

type Analytics = {
  window_days: number;
  open_requests: number;
  duplicates_merged: number;
  incidents_active: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  sla: { active_clocks: number; warnings: number; breached: number; paused_for_parts: number; compliance_pct: number };
  utilisation: { spaces_healthy: number; spaces_faulty: number; technicians_available: number; technicians_active: number; bookings_active: number };
  shortages: Array<{ sku_code: string; on_hand: number; reserved: number; reorder_threshold: number }>;
  recurring_faults: Array<{ space_code: string; category: string; reports: number }>;
  procurement: Record<string, number>;
};

const statusOrder = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS', 'RESOLVED', 'CLOSED', 'MERGED_DUPLICATE'];

export function AnalyticsWorkspace() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: result, error: rpcError } = await supabase.rpc('rpc_analytics_overview', { p_days: days });
      if (rpcError) throw new Error(rpcError.message);
      setData(result as Analytics);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load analytics');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const maxCategory = data ? Math.max(1, ...Object.values(data.by_category)) : 1;

  return <>
    <PageHeader
      eyebrow="Workspace 08 · Operational intelligence"
      title="Campus analytics"
      description="Open demand, SLA compliance, utilisation, stock shortages, recurring faults and the procurement funnel — computed from the live operational graph."
      actions={<div className="flex items-center gap-2">
        <select value={days} onChange={(event) => setDays(Number(event.target.value))} className="h-9 rounded-lg border border-stitch bg-white px-2 text-xs">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>
      </div>}
    />

    {error && <div className="mb-5"><ErrorBanner message={error} onRetry={() => void load()} /></div>}
    {loading && !data ? <Spinner label="Aggregating campus operations" /> : data && <>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Open requests', data.open_requests, Wrench, 'neutral'],
          ['SLA compliance', `${data.sla.compliance_pct}%`, BarChart3, data.sla.compliance_pct >= 90 ? 'green' : 'amber'],
          ['Active incidents', data.incidents_active, AlertTriangle, data.incidents_active > 0 ? 'red' : 'green'],
          ['Stock shortages', data.shortages.length, PackageX, data.shortages.length > 0 ? 'amber' : 'green'],
        ].map(([label, value, Icon, tone]) => {
          const IconComponent = Icon as typeof Wrench;
          return <Panel key={String(label)} className="p-4">
            <div className="flex items-center justify-between"><IconComponent className="h-4 w-4 text-stone" /><Badge tone={tone as 'neutral'}>{data.window_days}d</Badge></div>
            <p className="mono mt-4 text-2xl font-semibold">{String(value)}</p>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-stone">{String(label)}</p>
          </Panel>;
        })}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Panel className="p-5">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Request pipeline</h2><Badge tone="neutral">{data.duplicates_merged} merged</Badge></div>
          <div className="mt-4 space-y-2.5">
            {statusOrder.map((status) => {
              const count = data.by_status[status] ?? 0;
              const max = Math.max(1, ...Object.values(data.by_status));
              return <div key={status}>
                <div className="mb-1 flex items-center justify-between text-[10px] text-stone"><span>{status.replaceAll('_', ' ')}</span><span className="mono">{count}</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-silk"><div className="h-full rounded-full bg-obsidian" style={{ width: `${(count / max) * 100}%` }} /></div>
              </div>;
            })}
          </div>
          <div className="mt-5 border-t border-stitch pt-4">
            <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-stone">Faults by category</h3>
            {Object.entries(data.by_category).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([category, count]) => <div key={category} className="mb-1.5 flex items-center gap-2">
              <span className="w-28 truncate text-[10px]">{category.replaceAll('_', ' ')}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-silk"><div className="h-full rounded-full bg-stone" style={{ width: `${(count / maxCategory) * 100}%` }} /></div>
              <span className="mono w-6 text-right text-[10px] text-stone">{count}</span>
            </div>)}
          </div>
        </Panel>

        <div className="space-y-5">
          <Panel className="p-5">
            <h2 className="text-sm font-semibold">SLA & utilisation</h2>
            <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
              {[
                ['Active clocks', data.sla.active_clocks],
                ['Warnings', data.sla.warnings],
                ['Breached', data.sla.breached],
                ['Paused for parts', data.sla.paused_for_parts],
                ['Healthy spaces', data.utilisation.spaces_healthy],
                ['Faulted spaces', data.utilisation.spaces_faulty],
                ['Technicians free', data.utilisation.technicians_available],
                ['Technicians busy', data.utilisation.technicians_active],
                ['Active bookings', data.utilisation.bookings_active],
              ].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-stitch bg-linen p-2.5">
                <p className="text-[9px] uppercase tracking-wider text-stone">{String(label)}</p>
                <p className="mono mt-1 text-sm font-medium">{String(value)}</p>
              </div>)}
            </div>
          </Panel>

          <Panel className="p-5">
            <div className="flex items-center gap-2"><PackageX className="h-4 w-4" /><h2 className="text-sm font-semibold">Stock shortages</h2></div>
            {data.shortages.length === 0 ? <p className="mt-3 text-xs text-stone">Every SKU is above its reorder threshold.</p> : <div className="mt-3 space-y-2">
              {data.shortages.map((item) => <div key={item.sku_code} className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px]">
                <span className="mono">{item.sku_code}</span>
                <span className="text-amber-900">{item.on_hand} on hand · threshold {item.reorder_threshold}</span>
              </div>)}
            </div>}
          </Panel>

          <Panel className="p-5">
            <div className="flex items-center gap-2"><Repeat2 className="h-4 w-4" /><h2 className="text-sm font-semibold">Recurring faults</h2></div>
            {data.recurring_faults.length === 0 ? <p className="mt-3 text-xs text-stone">No space reported the same fault three times in this window.</p> : <div className="mt-3 space-y-1.5">
              {data.recurring_faults.map((item) => <div key={`${item.space_code}-${item.category}`} className="flex items-center justify-between text-[11px]">
                <span className="mono">{item.space_code}</span>
                <span className="text-stone">{item.category.replaceAll('_', ' ')} · {item.reports} reports</span>
              </div>)}
            </div>}
          </Panel>
        </div>
      </div>
    </>}
  </>;
}
