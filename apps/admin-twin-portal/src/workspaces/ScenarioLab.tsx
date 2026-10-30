import { useCallback, useEffect, useState } from 'react';
import { Droplets, RotateCcw, ShieldAlert, Zap } from 'lucide-react';
import { api } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { usePortalStore } from '../store/portalStore';
import type { ScenarioRun } from '../types';
import { Badge, Button, ErrorBanner, Panel, cx, formatDate } from '../components/ui';

const ALLOWED_ROLES = ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'];

const SCENARIOS = [
  {
    key: 'WATER_LEAK' as const,
    title: 'Flooded classroom',
    description: 'Ceiling leak during a live class: wet fans, flickering lights, a plumbing ticket and relocation pressure.',
    icon: Droplets,
  },
  {
    key: 'POWER_FAULT_LAB' as const,
    title: 'Lab power fault',
    description: 'Burning smell and sparks from a lab panel: safety override, critical SLA and equipment damage.',
    icon: Zap,
  },
];

function statusTone(status: ScenarioRun['status']): 'green' | 'red' | 'amber' | 'neutral' {
  if (status === 'COMPLETED') return 'green';
  if (status === 'REVERTED') return 'neutral';
  if (status === 'FAILED') return 'red';
  return 'amber';
}

export function ScenarioLab() {
  const { user } = useAuthStore();
  const { twinRevision, invalidateTwin } = usePortalStore();
  const [runs, setRuns] = useState<ScenarioRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canRun = Boolean(user && ALLOWED_ROLES.includes(user.role));

  const load = useCallback(async () => {
    try {
      setRuns(await api.scenarios.list());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load scenario history');
    }
  }, []);

  useEffect(() => {
    if (canRun) void load();
  }, [canRun, load, twinRevision]);

  if (!canRun) return null;

  const run = async (key: 'WATER_LEAK' | 'POWER_FAULT_LAB', title: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await api.scenarios.run(key);
      if (!result.success) throw new Error(result.error ?? 'SCENARIO_FAILED');
      setNotice(
        result.idempotent
          ? `${title} is already active: ${result.ticket_number ?? 'ticket'} in ${result.space_code ?? 'campus'}.`
          : `${title} started · ${result.ticket_number ?? 'ticket'} · ${result.work_order_number ?? 'work order'} · ${result.space_code ?? ''}`,
      );
      invalidateTwin('Disruption scenario changed campus state');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replaceAll('_', ' ').toLowerCase() : 'Scenario failed');
    } finally {
      setBusy(null);
    }
  };

  const reset = async (scenario: ScenarioRun) => {
    setBusy(`reset-${scenario.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await api.scenarios.reset(scenario.id);
      if (!result.success) throw new Error(result.error ?? 'RESET_FAILED');
      setNotice(`Scenario reverted; ${scenario.summary_json.space_code ?? 'space'} restored and the ticket resolved.`);
      invalidateTwin('Scenario reverted; campus state restored');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replaceAll('_', ' ').toLowerCase() : 'Reset failed');
    } finally {
      setBusy(null);
    }
  };

  const active = (key: 'WATER_LEAK' | 'POWER_FAULT_LAB') =>
    runs.find((scenario) => scenario.scenario_key === key && scenario.status === 'COMPLETED');

  return (
    <Panel className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-stitch px-5 py-4">
        <ShieldAlert className="h-4 w-4" />
        <h2 className="text-sm font-semibold">Disruption scenario lab</h2>
        <Badge tone="neutral" className="ml-auto">Replayable · recorded in audit</Badge>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2">
        {SCENARIOS.map((scenario) => {
          const Icon = scenario.icon;
          const current = active(scenario.key);
          const running = busy === scenario.key;
          return (
            <article key={scenario.key} className="rounded-xl border border-stitch bg-white p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-stitch bg-silk">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xs font-semibold">{scenario.title}</h3>
                    {current && <Badge tone="green">Active</Badge>}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-5 text-stone">{scenario.description}</p>
                </div>
              </div>

              {current ? (
                <div className="mt-3 rounded-lg border border-stitch bg-silk/60 p-2.5 text-[10px] text-stone">
                  <p className="mono flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-semibold text-ink">{current.summary_json.ticket_number}</span>
                    <span>{current.summary_json.space_code}</span>
                    {current.summary_json.work_order_number && <span>{current.summary_json.work_order_number}</span>}
                  </p>
                  <p className="mt-1">Started {formatDate(current.started_at)}</p>
                </div>
              ) : (
                <p className="mt-3 text-[10px] text-stone">
                  No active run. Running it creates a real complaint, work order and SLA clock.
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={current ? 'secondary' : 'primary'}
                  disabled={busy !== null}
                  onClick={() => void run(scenario.key, scenario.title)}
                >
                  {running ? 'Starting…' : current ? 'Run again (idempotent)' : 'Run scenario'}
                </Button>
                {current && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void reset(current)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {busy === `reset-${current.id}` ? 'Reverting…' : 'Revert run'}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {(notice || error) && (
        <div className="px-4 pb-3">
          {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">{notice}</p>}
          {error && <ErrorBanner message={error} />}
        </div>
      )}

      {runs.length > 0 && (
        <div className="border-t border-stitch px-4 py-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-stone">Recent runs</p>
          <ul className="space-y-1.5">
            {runs.slice(0, 5).map((scenario) => (
              <li key={scenario.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-stitch bg-white px-2.5 py-1.5 text-[10px]">
                <Badge tone={statusTone(scenario.status)}>{scenario.status}</Badge>
                <span className="font-medium">{scenario.title}</span>
                <span className="mono text-stone">{scenario.summary_json.ticket_number ?? '—'}</span>
                <span className="text-stone">{scenario.summary_json.space_code}</span>
                <span className="ml-auto text-stone">{formatDate(scenario.started_at)}</span>
                {scenario.status === 'COMPLETED' && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void reset(scenario)}
                    className={cx('rounded-md border border-stitch px-2 py-1 font-semibold uppercase tracking-wider text-stone transition hover:text-ink', busy === `reset-${scenario.id}` && 'opacity-50')}
                  >
                    Revert
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
