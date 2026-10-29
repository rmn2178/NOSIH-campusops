import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, FileKey2, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, EmptyState, ErrorBanner, PageHeader, Panel, Spinner, StatusBadge, cx, formatDate } from '../components/ui';
import type { AuditEntry, AuditVerification } from '../types';

export function AuditChainLedgerView() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [outcome, setOutcome] = useState('ALL');
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setEntries(await api.audit.list(activeQuery)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load audit ledger'); }
    finally { setLoading(false); }
  }, [activeQuery]);
  useEffect(() => { void load(); }, [load]);
  const verify = async () => {
    setVerifying(true); setError(null);
    try { setVerification(await api.audit.verify()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Chain verification failed'); }
    finally { setVerifying(false); }
  };
  const filtered = useMemo(() => outcome === 'ALL' ? entries : entries.filter((entry) => entry.outcome === outcome), [entries, outcome]);
  return <><PageHeader eyebrow="Workspace 07 · Immutable accountability" title="Append-only audit ledger" description="Every allowed, rejected, override and break-glass decision is appended to a protected server-side ledger. Verification confirms the sequence is contiguous and no entry has been rewritten." actions={<><Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button><Button size="sm" disabled={verifying} onClick={() => void verify()}><ShieldCheck className="h-3.5 w-3.5" />{verifying ? 'Verifying ledger…' : 'Verify ledger'}</Button></>} />
    {error && <div className="mb-5"><ErrorBanner message={error} /></div>}
    {verification && <div className={cx('mb-5 flex flex-col justify-between gap-4 rounded-xl border p-5 sm:flex-row sm:items-center', verification.verified ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50')}><div className="flex items-center gap-3">{verification.verified ? <CheckCircle2 className="h-6 w-6 text-emerald-700" /> : <XCircle className="h-6 w-6 text-red-700" />}<div><p className="text-sm font-semibold">{verification.verified ? 'Audit ledger verified' : 'Ledger integrity failure detected'}</p><p className="mt-1 text-xs text-stone">{verification.total_entries} entries confirmed in append-only order{verification.invalid_sequence_number ? ` · invalid row ${verification.invalid_sequence_number}` : ''}</p></div></div><div className="max-w-full sm:text-right"><p className="text-[9px] uppercase tracking-wider text-stone">Ledger mode</p><p className="mono mt-1 text-[10px]">APPEND_ONLY</p></div></div>}
    <Panel className="overflow-hidden"><div className="flex flex-col justify-between gap-3 border-b border-stitch p-4 lg:flex-row"><form onSubmit={(event) => { event.preventDefault(); setActiveQuery(query.trim()); }} className="relative flex-1 lg:max-w-md"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-stone" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search actor, action, resource or rule…" className="h-9 w-full rounded-lg border border-stitch bg-silk pl-9 pr-3 text-xs outline-none focus:bg-white" /></form><div className="flex flex-wrap gap-1">{['ALL', 'ALLOWED', 'REJECTED', 'OVERRIDE', 'BREAK_GLASS', 'AUTO_REASSIGNED'].map((item) => <button key={item} onClick={() => setOutcome(item)} className={cx('rounded-md px-2.5 py-2 text-[9px] font-medium', outcome === item ? 'bg-obsidian text-white' : 'bg-silk text-stone')}>{item.replaceAll('_', ' ')}</button>)}</div></div>
      {loading ? <Spinner label="Loading append-only audit rows" /> : filtered.length === 0 ? <EmptyState title="No audit entries found" description="Adjust the search or outcome filter. Protected actions create entries on the backend." /> : <div className="scrollbar-thin overflow-auto"><table className="w-full min-w-[1100px] border-collapse text-left"><thead className="bg-silk text-[9px] uppercase tracking-wider text-stone"><tr>{['Seq / Time', 'Actor', 'Action & resource', 'Outcome', 'Rule fired', 'Entry', ''].map((heading) => <th key={heading} className="px-4 py-3 font-medium">{heading}</th>)}</tr></thead><tbody className="divide-y divide-stitch">{filtered.map((entry) => <AuditRow key={entry.id} entry={entry} expanded={expanded === entry.id} onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)} />)}</tbody></table></div>}
    </Panel>
  </>;
}

function AuditRow({ entry, expanded, onToggle }: { entry: AuditEntry; expanded: boolean; onToggle: () => void }) {
  return <>
    <tr className={cx('align-top text-xs', expanded && 'bg-linen')}><td className="px-4 py-4"><p className="mono text-[10px] font-semibold">#{entry.sequence_number}</p><p className="mt-1 whitespace-nowrap text-[9px] text-stone">{formatDate(entry.timestamp)}</p></td><td className="px-4 py-4"><p className="text-[11px] font-medium">{entry.actor_email}</p><p className="mt-1 text-[9px] uppercase tracking-wider text-stone">{entry.actor_role.replaceAll('_', ' ')}</p></td><td className="px-4 py-4"><p className="text-[11px] font-medium">{entry.action.replaceAll('_', ' ')}</p><p className="mono mt-1 text-[9px] text-stone">{entry.resource_type} / {entry.resource_id}</p></td><td className="px-4 py-4"><StatusBadge status={entry.outcome} /></td><td className="max-w-[220px] px-4 py-4"><p className="break-words text-[10px] leading-4 text-stone">{entry.rule_fired ?? '—'}</p></td><td className="px-4 py-4"><div className="flex items-center gap-2"><FileKey2 className="h-3.5 w-3.5 text-stone" /><span className="mono text-[9px]">#{entry.sequence_number}</span></div></td><td className="px-4 py-4"><button onClick={onToggle} aria-label="Toggle audit entry details"><ChevronDown className={cx('h-4 w-4 transition', expanded && 'rotate-180')} /></button></td></tr>
    {expanded && <tr className="bg-linen"><td colSpan={7} className="px-6 py-4"><div className="grid gap-3 lg:grid-cols-2"><div><p className="text-[9px] font-semibold uppercase tracking-wider text-stone">Ledger entry</p><p className="mono mt-2 rounded-lg bg-white p-3 text-[10px] leading-4">{entry.id} · #{entry.sequence_number}</p></div><div><p className="text-[9px] font-semibold uppercase tracking-wider text-stone">Recorded at</p><p className="mono mt-2 rounded-lg bg-white p-3 text-[10px] leading-4">{formatDate(entry.timestamp)}</p></div></div>{entry.reason && <div className="mt-3"><Badge tone="neutral">Reason</Badge><p className="mt-2 text-xs leading-5 text-stone">{entry.reason}</p></div>}</td></tr>}
  </>;
}
