import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { Button, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { usePortalStore } from '../store/portalStore';
import type { Incident, SlaClock, WorkOrder } from '../types';
import { IncidentCorrelationDesk } from './IncidentCorrelationDesk';
import { WorkOrderDispatchBoard } from './WorkOrderDispatchBoard';

export function DispatchWorkspace() {
  const { twinRevision } = usePortalStore();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [slaClocks, setSlaClocks] = useState<SlaClock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [incidentData, workOrderData, slaData] = await Promise.all([api.incidents.list(), api.workOrders.list(), api.sla.list()]);
      setIncidents(incidentData); setWorkOrders(workOrderData); setSlaClocks(slaData);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load dispatch data'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load, twinRevision]);
  return <><PageHeader eyebrow="Workspace 02 · Response coordination" title="Incidents & work order dispatch" description="Correlate topological root causes, inspect duplicate merges, and assign constrained maintenance capacity without hiding unavailable resources." actions={<Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>} />
    {error && <div className="mb-5"><ErrorBanner message={error} onRetry={() => void load()} /></div>}{loading && workOrders.length === 0 ? <Spinner label="Loading incidents and work orders" /> : <div className="grid items-start gap-5 2xl:grid-cols-2"><IncidentCorrelationDesk incidents={incidents} /><WorkOrderDispatchBoard workOrders={workOrders} slaClocks={slaClocks} onChanged={() => void load()} /></div>}</>;
}
