import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Users } from 'lucide-react';
import { api } from '../api/client';
import { Button, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { usePortalStore } from '../store/portalStore';
import type { Incident, SlaClock, WorkforceSummary, WorkOrder } from '../types';
import { IncidentCorrelationDesk } from './IncidentCorrelationDesk';
import { PulsePanel } from './PulsePanel';
import { ScenarioLab } from './ScenarioLab';
import { WorkOrderDispatchBoard } from './WorkOrderDispatchBoard';

export function DispatchWorkspace() {
  const { twinRevision } = usePortalStore();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [slaClocks, setSlaClocks] = useState<SlaClock[]>([]);
  const [workforce, setWorkforce] = useState<WorkforceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [incidentData, workOrderData, slaData, workforceData] = await Promise.all([
        api.incidents.list(),
        api.workOrders.list(),
        api.sla.list(),
        api.operations.workforce().catch(() => null),
      ]);
      setIncidents(incidentData); setWorkOrders(workOrderData); setSlaClocks(slaData); setWorkforce(workforceData);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load dispatch data'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load, twinRevision]);
  return <><PageHeader eyebrow="Workspace 02 · Response coordination" title="Incidents & work order dispatch" description="Correlate topological root causes, inspect duplicate merges, and assign constrained maintenance capacity without hiding unavailable resources." actions={<Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>} />
    {error && <div className="mb-5"><ErrorBanner message={error} onRetry={() => void load()} /></div>}
    <ScenarioLab />
    <PulsePanel />
    {workforce && <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-stitch bg-white px-5 py-3">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider"><Users className="h-3.5 w-3.5" />Workforce</span>
      <span className="text-[11px]"><b className="text-sm">{workforce.total}</b> technicians</span>
      <span className="text-[11px] text-stone">{workforce.on_shift} on shift · {workforce.available} available · {workforce.on_leave} on leave</span>
      <span className="ml-auto flex flex-wrap gap-1.5">{workforce.by_skill.map((skill) => <span key={skill.skill} className="mono rounded-md border border-stitch bg-silk px-2 py-1 text-[9px] text-stone">{skill.skill.replaceAll('_', ' ')} {skill.available}/{skill.total}</span>)}</span>
    </div>}
    {loading && workOrders.length === 0 ? <Spinner label="Loading incidents and work orders" /> : <div className="grid items-start gap-5 2xl:grid-cols-2"><IncidentCorrelationDesk incidents={incidents} /><WorkOrderDispatchBoard workOrders={workOrders} slaClocks={slaClocks} onChanged={() => void load()} /></div>}</>;
}
