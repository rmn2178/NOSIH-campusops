import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarCheck, Check, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, EmptyState, ErrorBanner, PageHeader, Panel, Spinner, cx } from '../components/ui';
import type { TimetableSlot, TimetableValidation } from '../types';

const days = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
const times = ['09:00–09:50', '09:50–10:40', '10:55–11:45', '11:45–12:35', '13:20–14:10', '14:10–15:00'];

export function TimetableWorkspace() {
  const [validation, setValidation] = useState<TimetableValidation | null>(null);
  const [slots, setSlots] = useState<TimetableSlot[]>([]);
  const [query, setQuery] = useState('C4-03');
  const [submittedQuery, setSubmittedQuery] = useState('C4-03');
  const [mode, setMode] = useState<'space' | 'class'>('space');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const validate = useCallback(async () => {
    setError(null);
    try { setValidation(await api.timetable.validate()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Timetable validation failed'); }
  }, []);
  const search = useCallback(async () => {
    if (!submittedQuery.trim()) return;
    setLoading(true); setError(null);
    try { setSlots(mode === 'space' ? await api.timetable.forSpace(submittedQuery.trim()) : await api.timetable.forClass(submittedQuery.trim())); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Timetable lookup failed'); setSlots([]); }
    finally { setLoading(false); }
  }, [mode, submittedQuery]);
  useEffect(() => { void validate(); void search(); }, [validate, search]);
  const slotAt = useMemo(() => {
    const map = new Map<string, TimetableSlot[]>();
    slots.forEach((slot) => map.set(`${slot.day_of_week}-${slot.period_number}`, [...(map.get(`${slot.day_of_week}-${slot.period_number}`) ?? []), slot]));
    return map;
  }, [slots]);
  return <><PageHeader eyebrow="Academic constraint engine · 2,700 slots" title="Timetable validation & inspection" description="Inspect the CP-SAT schedule by canonical space or class. Validation independently rechecks lab balance, collisions, staff overlap and the fifteen vacant home rooms per period." actions={<Button variant="secondary" size="sm" onClick={() => void validate()}><RefreshCw className="h-3.5 w-3.5" />Revalidate all slots</Button>} />
    {error && <div className="mb-5"><ErrorBanner message={error} /></div>}
    {validation && <Panel className="mb-5 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><div className={cx('rounded-lg p-2', validation.valid ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}><CalendarCheck className="h-5 w-5" /></div><div><h2 className="text-sm font-semibold">{validation.valid ? 'All hard constraints satisfied' : 'Constraint violations detected'}</h2><p className="mono mt-1 text-[10px] text-stone">{validation.total_slots} timetable slots verified</p></div></div><StatusBadge valid={validation.valid} /></div><div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">{Object.entries(validation.constraint_results).map(([key, value]) => <div key={key} className="flex items-start gap-2 rounded-lg border border-stitch bg-linen p-3"><span className={cx('mt-0.5 rounded-full p-0.5', value === true || (key === 'vacant_home_rooms_per_period' && value === 15) ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')}>{value === false ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}</span><div><p className="text-[10px] font-medium leading-4">{key.replaceAll('_', ' ')}</p><p className="mono mt-1 text-[9px] text-stone">{String(value)}</p></div></div>)}</div></Panel>}
    <Panel className="overflow-hidden"><div className="border-b border-stitch p-5"><form onSubmit={(event) => { event.preventDefault(); const nextQuery = query.trim(); if (nextQuery === submittedQuery) void search(); else setSubmittedQuery(nextQuery); }} className="flex flex-col gap-2 sm:flex-row"><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} className="h-10 rounded-lg border border-stitch bg-white px-3 text-xs"><option value="space">Inspect space</option><option value="class">Inspect class</option></select><div className="relative flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-stone" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="mono h-10 w-full rounded-lg border border-stitch bg-silk pl-10 pr-3 text-xs uppercase outline-none focus:bg-white" placeholder={mode === 'space' ? 'C4-03 or LAB-OOPS-01' : 'CSE-Y2-B'} /></div><Button type="submit">Load schedule</Button></form></div>
      {loading ? <Spinner label="Loading timetable slots" /> : slots.length === 0 ? <EmptyState title="No timetable slots returned" description="Check the class or space code and query the backend again." /> : <div className="scrollbar-thin overflow-auto"><table className="w-full min-w-[1050px] border-collapse"><thead><tr className="bg-silk text-left text-[9px] uppercase tracking-wider text-stone"><th className="w-32 px-4 py-3 font-medium">Period</th>{days.map((day) => <th key={day} className="px-3 py-3 font-medium">{day}</th>)}</tr></thead><tbody className="divide-y divide-stitch">{times.map((time, periodIndex) => <tr key={time}><td className="bg-linen px-4 py-3"><p className="mono text-xs font-semibold">P{periodIndex + 1}</p><p className="mono mt-1 text-[9px] text-stone">{time}</p></td>{days.map((day) => { const cellSlots = slotAt.get(`${day}-${periodIndex + 1}`) ?? []; return <td key={day} className="min-w-[170px] border-l border-stitch p-2 align-top">{cellSlots.length === 0 ? <span className="text-[10px] text-stone">No session</span> : <div className="space-y-1">{cellSlots.map((slot, index) => <div key={slot.id ?? `${slot.class_code}-${index}`} className={cx('rounded-lg border p-2.5', slot.session_type === 'LAB' ? 'border-purple-200 bg-purple-50' : slot.is_relocated ? 'border-cyan-200 bg-cyan-50' : 'border-stitch bg-white')}><div className="flex items-center justify-between"><span className="mono text-[9px] font-semibold">{slot.class_code}</span><Badge tone={slot.session_type === 'LAB' ? 'violet' : slot.is_relocated ? 'cyan' : 'green'}>{slot.session_type}</Badge></div><p className="mt-2 line-clamp-2 text-[10px] leading-4">{slot.subject_title}</p><p className="mono mt-2 text-[8px] text-stone">{slot.effective_space_code}</p>{slot.faculty_name && <p className="mt-1 truncate text-[9px] text-stone">{slot.faculty_name}</p>}</div>)}</div>}</td>; })}</tr>)}</tbody></table></div>}
    </Panel>
  </>;
}

function StatusBadge({ valid }: { valid: boolean }) {
  return <Badge tone={valid ? 'green' : 'red'} dot>{valid ? 'Valid schedule' : 'Invalid schedule'}</Badge>;
}
