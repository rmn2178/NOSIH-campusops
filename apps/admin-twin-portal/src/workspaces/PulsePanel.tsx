import { useCallback, useEffect, useState } from 'react';
import {
  Bot, DoorOpen, FlaskConical, HeartPulse, Pause, Play, RotateCcw,
  UtensilsCrossed, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { usePortalStore } from '../store/portalStore';
import type { PulseEvent, PulseFacilityKind, PulseStatus } from '../types';
import { Badge, Button, ErrorBanner, Panel, cx, formatDate } from '../components/ui';

const CONTROL_ROLES = ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'];
const VIEWER_ROLES = [...CONTROL_ROLES, 'DEPARTMENT_MANAGER'];

const FACILITY_META: Record<PulseFacilityKind, { label: string; icon: LucideIcon }> = {
  CANTEEN: { label: 'Canteen', icon: UtensilsCrossed },
  BILL_BOT: { label: 'Bill bot', icon: Bot },
  LAB: { label: 'Lab', icon: FlaskConical },
  ROOM: { label: 'Classroom', icon: DoorOpen },
};

const INTERVALS = [5, 10, 15, 30, 60];
const HEAL_OPTIONS = [0, 4, 12, 24];

function ageLabel(iso: string | null): string {
  if (!iso) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function eventTone(status: PulseEvent['status']): 'green' | 'red' | 'neutral' | 'amber' {
  if (status === 'ACTIVE') return 'red';
  if (status === 'COMPLETED') return 'green';
  return 'neutral';
}

function EventRow({ event, canRevert, busyId, onRevert }: {
  event: PulseEvent;
  canRevert: boolean;
  busyId: number | null;
  onRevert: (event: PulseEvent) => void;
}) {
  const meta = FACILITY_META[event.facility_kind] ?? FACILITY_META.ROOM;
  const Icon = meta.icon;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-stitch bg-white px-2.5 py-2 text-[10px]">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-stitch bg-silk">
        <Icon className="h-3 w-3" />
      </span>
      <Badge tone={eventTone(event.status)}>{event.status}</Badge>
      <span className="mono font-semibold text-ink">{event.ticket_number ?? '—'}</span>
      <span className="mono text-stone">{event.space_code}</span>
      <span className="text-stone">{meta.label}</span>
      {event.is_anonymous && <span className="text-stone">anonymous</span>}
      <span className="ml-auto text-stone" title={event.description}>{ageLabel(event.closed_at ?? event.created_at)}</span>
      {canRevert && event.status === 'ACTIVE' && (
        <button
          type="button"
          disabled={busyId !== null}
          onClick={() => onRevert(event)}
          className={cx('flex items-center gap-1 rounded-md border border-stitch px-2 py-1 font-semibold uppercase tracking-wider text-stone transition hover:text-ink', busyId === event.id && 'opacity-50')}
        >
          <RotateCcw className="h-3 w-3" />
          {busyId === event.id ? 'Reverting…' : 'Revert'}
        </button>
      )}
    </li>
  );
}

export function PulsePanel() {
  const { user } = useAuthStore();
  const { twinRevision, invalidateTwin } = usePortalStore();
  const [status, setStatus] = useState<PulseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyEventId, setBusyEventId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canView = Boolean(user && VIEWER_ROLES.includes(user.role));
  const canControl = Boolean(user && CONTROL_ROLES.includes(user.role));

  const load = useCallback(async () => {
    try {
      const next = await api.pulse.status();
      if (next.success === false) throw new Error(next.error ?? 'FORBIDDEN');
      setStatus(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load pulse status');
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [canView, load, twinRevision]);

  if (!canView) return null;

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replaceAll('_', ' ').toLowerCase() : 'Pulse action failed');
    } finally {
      setBusy(false);
    }
  };

  const runNow = () =>
    act(async () => {
      const result = await api.pulse.runNow();
      if (result.fired) {
        invalidateTwin('Pulse injected a live fault');
        return `Injected ${result.template_key} at ${result.space_code} · ${result.ticket_number} · ${result.work_order_number}`;
      }
      return result.reason ? `No injection: ${result.reason.replaceAll('_', ' ').toLowerCase()}` : 'No injection';
    });

  const setEnabled = (enabled: boolean) =>
    act(async () => {
      await api.pulse.configure({ enabled });
      invalidateTwin(enabled ? 'Campus pulse resumed' : 'Campus pulse paused');
      return enabled ? 'Campus pulse resumed' : 'Campus pulse paused';
    });

  const patch = (body: { intervalMinutes?: number; autoHealHours?: number }) =>
    act(async () => {
      await api.pulse.configure(body);
      return 'Pulse configuration updated';
    });

  const revert = (event: PulseEvent) => {
    setBusyEventId(event.id);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        const result = (await api.pulse.revert(event.id)) as { success?: boolean; error?: string };
        if (!result.success) throw new Error(result.error ?? 'REVERT_FAILED');
        setNotice(`Reverted ${event.ticket_number} — ${event.space_code} restored`);
        invalidateTwin('Pulse event reverted; twin state restored');
        await load();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message.replaceAll('_', ' ').toLowerCase() : 'Revert failed');
      } finally {
        setBusyEventId(null);
      }
    })();
  };

  const live = status?.enabled ?? false;

  return (
    <Panel className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-stitch px-5 py-4">
        <HeartPulse className={cx('h-4 w-4', live && 'text-red-600')} />
        <h2 className="text-sm font-semibold">Campus pulse</h2>
        <Badge tone={live ? 'green' : 'neutral'}>{live ? 'Live' : 'Paused'}</Badge>
        <Badge tone="neutral" className="ml-auto">Simulated faults through the real pipeline</Badge>
      </div>

      {status ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-[11px] text-stone">
          <span>Every <span className="mono font-semibold text-ink">{status.interval_minutes}m</span></span>
          <span>Open simulated <span className="mono font-semibold text-ink">{status.open_simulated}/{status.max_open_simulated}</span></span>
          <span>Injected 24h <span className="mono font-semibold text-ink">{status.injected_24h}</span></span>
          <span>Healed 24h <span className="mono font-semibold text-ink">{status.healed_24h}</span></span>
          <span>Auto-heal <span className="mono font-semibold text-ink">{status.auto_heal_hours > 0 ? `${status.auto_heal_hours}h` : 'off'}</span></span>
          <span className="ml-auto">Last tick {status.last_tick_at ? formatDate(status.last_tick_at) : '—'}</span>
        </div>
      ) : (
        <p className="px-5 py-3 text-[11px] text-stone">Loading pulse state…</p>
      )}

      {canControl && (
        <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
          <Button size="sm" disabled={busy} onClick={() => void runNow()}>
            <Zap className="h-3.5 w-3.5" />
            {busy ? 'Working…' : 'Run now'}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void setEnabled(!live)}>
            {live ? <><Pause className="h-3.5 w-3.5" />Pause</> : <><Play className="h-3.5 w-3.5" />Resume</>}
          </Button>
          <label className="ml-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone">
            Cadence
            <select
              value={status?.interval_minutes ?? 15}
              disabled={busy}
              onChange={(event) => void patch({ intervalMinutes: Number(event.target.value) })}
              className="mono rounded-md border border-stitch bg-white px-2 py-1.5 text-[10px] text-ink outline-none"
            >
              {INTERVALS.map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone">
            Auto-heal
            <select
              value={status?.auto_heal_hours ?? 0}
              disabled={busy}
              onChange={(event) => void patch({ autoHealHours: Number(event.target.value) })}
              className="mono rounded-md border border-stitch bg-white px-2 py-1.5 text-[10px] text-ink outline-none"
            >
              {HEAL_OPTIONS.map((hours) => <option key={hours} value={hours}>{hours === 0 ? 'off' : `${hours} h`}</option>)}
            </select>
          </label>
        </div>
      )}

      {(notice || error) && (
        <div className="px-5 pb-3">
          {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">{notice}</p>}
          {error && <ErrorBanner message={error} />}
        </div>
      )}

      {status && (
        <div className="border-t border-stitch px-5 py-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-stone">Active simulated faults</p>
          {status.active_events.length === 0 ? (
            <p className="text-[11px] text-stone">None right now — the next fault lands within the cadence window.</p>
          ) : (
            <ul className="space-y-1.5">
              {status.active_events.map((event) => (
                <EventRow key={event.id} event={event} canRevert={canControl} busyId={busyEventId} onRevert={revert} />
              ))}
            </ul>
          )}

          {status.recent_events.length > 0 && (
            <>
              <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wider text-stone">Recent pulse events</p>
              <ul className="space-y-1.5">
                {status.recent_events.slice(0, 6).map((event) => (
                  <EventRow key={event.id} event={event} canRevert={false} busyId={null} onRevert={revert} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
