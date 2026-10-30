import { useCallback, useEffect, useState } from 'react';
import { Award, Briefcase, CalendarClock, Mail, MapPin, ShieldCheck, Wrench } from 'lucide-react';
import { api } from '../../api/client';
import type { StaffProfile } from '../../types';
import { Badge, ErrorBanner, Modal, Spinner, cx, formatDate } from '../ui';

const EMPTY = (label: string) => (
  <p className="rounded-lg border border-dashed border-stitch p-3 text-[11px] leading-4 text-stone">{label}</p>
);

function stateTone(profile: StaffProfile): { tone: 'green' | 'amber' | 'red'; label: string } {
  if (profile.is_on_leave) return { tone: 'red', label: 'On leave' };
  if (!profile.is_on_shift) return { tone: 'amber', label: 'Off shift' };
  if (profile.current_active_jobs >= profile.max_concurrent_jobs) return { tone: 'amber', label: 'At capacity' };
  return { tone: 'green', label: 'On shift · available' };
}

export function StaffProfileModal({ code, onClose }: { code: string | null; onClose: () => void }) {
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      setProfile(await api.operations.staffProfile(code));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load the staff profile');
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => { void load(); }, [load]);

  const state = profile ? stateTone(profile) : null;

  return <Modal open={code !== null} onClose={onClose} title={profile ? profile.full_name : 'Staff profile'} description={profile ? `${profile.staff_code} · ${profile.staff_category.replaceAll('_', ' ').toLowerCase()} · every job and repair on record` : 'Loading the staff record'} wide>
    {loading && !profile ? <Spinner label="Loading staff record" /> : <div className="space-y-5">
      {error && <ErrorBanner message={error} onRetry={() => void load()} />}
      {profile && <>
        <section className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-stitch bg-white p-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-stitch bg-silk"><Wrench className="h-5 w-5" /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{profile.full_name}</p>
              <Badge tone="neutral">{profile.staff_code}</Badge>
              {state && <Badge tone={state.tone}>{state.label}</Badge>}
              <Badge tone="neutral">{profile.primary_skill.replaceAll('_', ' ')}</Badge>
            </div>
            <p className="mono mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone">
              <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{profile.email}</span>
              <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{profile.current_block_location ? `Block ${profile.current_block_location}` : 'Unassigned block'}</span>
              <span className="flex items-center gap-1"><CalendarClock className="h-3 w-3" />{profile.shift_code} shift</span>
              <span className="flex items-center gap-1"><Award className="h-3 w-3" />proficiency {profile.skill_proficiency ?? '—'}/5</span>
              <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" />{profile.risk_clearance.replaceAll('_', ' ')}</span>
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-[9px] uppercase tracking-wider text-stone">Workload</p>
            <p className="mono text-sm font-semibold">{profile.current_active_jobs}/{profile.max_concurrent_jobs}</p>
            <p className="text-[9px] text-stone">₹{Math.round(profile.hourly_cost_inr ?? 0)}/hour · {profile.department_code ?? 'central'}</p>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {[
            ['Jobs total', profile.stats.jobs_total],
            ['Open jobs', profile.stats.jobs_open],
            ['Completed', profile.stats.jobs_completed],
            ['Repairs', profile.stats.repairs_count],
            ['Repair spend', `₹${Math.round(profile.stats.repair_cost_inr).toLocaleString('en-IN')}`],
            ['Avg downtime', `${profile.stats.avg_downtime_mins}m`],
          ].map(([label, value]) => <div key={label} className="rounded-lg border border-stitch bg-white p-3"><p className="text-[9px] uppercase tracking-wider text-stone">{label}</p><p className="mono mt-1 text-sm font-semibold">{value}</p></div>)}
        </section>

        <section className="rounded-xl border border-stitch bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold"><Briefcase className="h-3.5 w-3.5" />Work orders</p>
            <Badge tone="neutral">{profile.jobs.length} most recent</Badge>
          </div>
          {profile.jobs.length === 0 ? EMPTY('No work orders assigned to this technician yet.') : <ul className="space-y-1.5">
            {profile.jobs.map((job) => <li key={job.wo_number} className="flex flex-wrap items-center gap-2 rounded-lg border border-stitch px-2.5 py-1.5 text-[10px]">
              <span className="mono font-semibold">{job.wo_number}</span>
              <span className="mono text-stone">{job.space_code}</span>
              <span className="text-stone">{job.required_skill.replaceAll('_', ' ')}</span>
              <Badge tone={['RESOLVED', 'COMPLETED', 'CLOSED'].includes(job.status) ? 'green' : job.status === 'BLOCKED_PARTS' ? 'red' : 'amber'}>{job.status.replaceAll('_', ' ')}</Badge>
              <span className="ml-auto text-stone">{job.completed_at ? `closed ${formatDate(job.completed_at)}` : job.created_at ? `raised ${formatDate(job.created_at)}` : '—'}</span>
            </li>)}
          </ul>}
        </section>

        <section className="rounded-xl border border-stitch bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold"><Wrench className="h-3.5 w-3.5" />Repairs performed</p>
            <Badge tone="neutral">{profile.repairs.length} most recent</Badge>
          </div>
          {profile.repairs.length === 0 ? EMPTY('No priced repairs recorded for this technician yet.') : <ul className="space-y-1.5">
            {profile.repairs.map((repair) => <li key={`${repair.asset_code}-${repair.completed_at}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-stitch px-2.5 py-1.5 text-[10px]">
              <span className="mono font-semibold">{repair.asset_code || `${repair.space_code} · space-level`}</span>
              <span className="mono text-stone">{repair.space_code}</span>
              <span className="truncate text-stone">{repair.fault_category.replaceAll('_', ' ').toLowerCase()}</span>
              <span className="ml-auto text-stone">{formatDate(repair.completed_at ?? undefined)}</span>
              <span className={cx('mono font-semibold', (repair.total_cost_inr ?? 0) > 0 ? 'text-ink' : 'text-stone')}>₹{Math.round(repair.total_cost_inr ?? 0)}</span>
            </li>)}
          </ul>}
        </section>
      </>}
    </div>}
  </Modal>;
}
