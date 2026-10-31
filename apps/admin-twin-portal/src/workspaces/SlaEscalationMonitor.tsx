import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BellRing, Clock3, Pause, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import type { SlaBoard, SlaBoardRow, SlaComplianceReport, SlaMatrix } from '../api/client';
import { Badge, Button, ErrorBanner, PageHeader, Panel, Spinner } from '../components/ui';
import { useAuthStore } from '../store/authStore';
import { usePortalStore } from '../store/portalStore';
import type { NotificationLog } from '../types';
import { SlaClockList } from './sla/SlaClockList';
import { SlaCompliancePanel } from './sla/SlaCompliancePanel';
import { SlaEscalationTimeline } from './sla/SlaEscalationTimeline';
import { SlaPolicyMatrixPanel } from './sla/SlaPolicyMatrixPanel';
import { SLA_CONTROL_ROLES, describeActionError, type PauseReason } from './sla/slaFormat';

const EMPTY_SUMMARY = {
  total: 0,
  healthy: 0,
  warning: 0,
  breached: 0,
  paused: 0,
  closed: 0,
  response_pending: 0,
};

export function SlaEscalationMonitor() {
  const { twinRevision } = usePortalStore();
  const { user } = useAuthStore();

  const [matrix, setMatrix] = useState<SlaMatrix | null>(null);
  const [board, setBoard] = useState<SlaBoard | null>(null);
  const [compliance, setCompliance] = useState<SlaComplianceReport | null>(null);
  const [notifications, setNotifications] = useState<NotificationLog[]>([]);

  const [filter, setFilter] = useState('ALL');
  const [windowDays, setWindowDays] = useState(90);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const [boardLoading, setBoardLoading] = useState(true);
  const [complianceLoading, setComplianceLoading] = useState(true);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [complianceError, setComplianceError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const message = (reason: unknown, fallback: string) =>
    reason instanceof Error ? reason.message : fallback;

  // The policy matrix and the operating calendar change rarely.
  const refreshMatrix = useCallback(async () => {
    try {
      setMatrix(await api.sla.matrix());
      setMatrixError(null);
    } catch (reason) {
      setMatrixError(message(reason, 'Unable to load the SLA policy matrix'));
    }
  }, []);

  // The board is the live truth: it is reloaded on every filter change, on
  // every twin revision and once a minute while the console is open.
  const refreshBoard = useCallback(async () => {
    try {
      const result = await api.sla.board(filter);
      setBoard(result);
      setLoadedAt(Date.now());
      setBoardError(null);
    } catch (reason) {
      setBoardError(message(reason, 'Unable to load the SLA clocks'));
    } finally {
      setBoardLoading(false);
    }
  }, [filter]);

  const refreshCompliance = useCallback(async (days: number) => {
    setComplianceLoading(true);
    try {
      setCompliance(await api.sla.compliance(days));
      setComplianceError(null);
    } catch (reason) {
      setComplianceError(message(reason, 'Unable to load the SLA compliance report'));
    } finally {
      setComplianceLoading(false);
    }
  }, []);

  const refreshNotifications = useCallback(async () => {
    try {
      setNotifications(await api.integrations.notifications());
    } catch {
      // The delivery log is supporting evidence; it must never blank the console.
      setNotifications([]);
    }
  }, []);

  useEffect(() => { void refreshMatrix(); }, [refreshMatrix, twinRevision]);
  useEffect(() => { void refreshBoard(); }, [refreshBoard, twinRevision]);
  useEffect(() => { void refreshCompliance(windowDays); }, [refreshCompliance, windowDays, twinRevision]);
  useEffect(() => { void refreshNotifications(); }, [refreshNotifications, twinRevision]);

  // The countdown is projected forward from the server value; it has to move
  // on its own, so the console wakes up twice a minute.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshBoard(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshBoard]);

  const selected = useMemo<SlaBoardRow | null>(() => {
    const rows = board?.rows ?? [];
    return rows.find((row) => row.work_order_id === selectedId) ?? rows[0] ?? null;
  }, [board, selectedId]);

  const canControl = useMemo(
    () => (user ? (SLA_CONTROL_ROLES as readonly string[]).includes(user.role) : false),
    [user],
  );

  const pause = useCallback(async (reason: PauseReason) => {
    if (!selected) return;
    setActionPending(true);
    setActionError(null);
    try {
      const result = await api.sla.pauseClock(selected.work_order_id, reason, user?.email ?? '');
      if (!result.success) {
        setActionError(describeActionError(result.error));
        return;
      }
      await refreshBoard();
    } catch (reason) {
      setActionError(message(reason, 'Unable to pause the clock'));
    } finally {
      setActionPending(false);
    }
  }, [selected, user, refreshBoard]);

  const resume = useCallback(async () => {
    if (!selected) return;
    setActionPending(true);
    setActionError(null);
    try {
      const result = await api.sla.resumeClock(selected.work_order_id, user?.email ?? '');
      if (!result.success) {
        setActionError(describeActionError(result.error));
        return;
      }
      await refreshBoard();
    } catch (reason) {
      setActionError(message(reason, 'Unable to resume the clock'));
    } finally {
      setActionPending(false);
    }
  }, [selected, user, refreshBoard]);

  const summary = board?.summary ?? EMPTY_SUMMARY;
  const tiles = [
    { label: 'Clocks tracked', value: summary.total, Icon: Clock3, tone: 'neutral' as const },
    { label: 'Healthy', value: summary.healthy, Icon: Clock3, tone: 'green' as const },
    { label: 'At 75 % warning', value: summary.warning, Icon: BellRing, tone: 'amber' as const },
    { label: 'Breached', value: summary.breached, Icon: AlertTriangle, tone: 'red' as const },
    { label: 'Paused', value: summary.paused, Icon: Pause, tone: 'violet' as const },
    { label: 'Awaiting a reply', value: summary.response_pending, Icon: BellRing, tone: 'neutral' as const },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Workspace 04 · Time-based accountability"
        title="SLA & escalation command"
        description="Policy, live countdowns and per-department compliance for every campus request."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void refreshMatrix();
              void refreshBoard();
              void refreshCompliance(windowDays);
              void refreshNotifications();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75}/>
            Refresh
          </Button>
        }
      />

      {boardError && (
        <div className="mb-5">
          <ErrorBanner message={boardError} onRetry={() => void refreshBoard()} />
        </div>
      )}

      {boardLoading && !board ? (
        <Spinner label="Loading SLA clocks and policy matrix" />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {tiles.map(({ label, value, Icon, tone }) => (
              <Panel key={label} className="p-4">
                <div className="flex items-center justify-between">
                  <Icon className="h-4 w-4 text-stone" strokeWidth={1.75} />
                  <Badge tone={tone}>{value}</Badge>
                </div>
                <p className="mt-4 text-[10px] uppercase tracking-wider text-stone">{label}</p>
              </Panel>
            ))}
          </div>

          <SlaPolicyMatrixPanel
            matrix={matrix}
            error={matrixError}
            onRetry={() => void refreshMatrix()}
          />

          <div className="mb-5 grid items-start gap-5 xl:grid-cols-[1.05fr_.95fr]">
            <SlaClockList
              rows={board?.rows ?? []}
              summary={summary}
              filter={filter}
              onFilterChange={setFilter}
              selectedId={selected?.work_order_id ?? null}
              onSelect={setSelectedId}
              loadedAt={loadedAt}
              now={now}
              loading={boardLoading}
            />
            <SlaEscalationTimeline
              row={selected}
              notifications={notifications}
              canControl={canControl}
              actionError={actionError}
              actionPending={actionPending}
              onPause={(reason) => void pause(reason)}
              onResume={() => void resume()}
            />
          </div>
        </>
      )}

      <SlaCompliancePanel
        report={compliance}
        days={windowDays}
        onDaysChange={setWindowDays}
        loading={complianceLoading}
        error={complianceError}
        onRetry={() => void refreshCompliance(windowDays)}
      />
    </>
  );
}
