import { useCallback, useEffect, useState } from 'react';
import { EyeOff, KeyRound, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { BreakGlassUnsealModal } from '../components/modals/BreakGlassUnsealModal';
import { Badge, Button, EmptyState, ErrorBanner, PageHeader, Panel, Spinner, StatusBadge, cx, formatDate } from '../components/ui';
import { useAuthStore } from '../store/authStore';
import type { ModerationItem } from '../types';

export function ModerationQueueView() {
  const { user } = useAuthStore();
  const [items, setItems] = useState<ModerationItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unsealItem, setUnsealItem] = useState<ModerationItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems(await api.moderation.list()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load moderation queue'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  return <><PageHeader eyebrow="Workspace 05 · Safety & privacy" title="Moderation queue & anonymity vault" description="Review submissions intercepted before publication or twin mutation. Anonymous identity remains sealed unless the System Administrator satisfies break-glass policy." actions={<Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>} />
    {error && <div className="mb-5"><ErrorBanner message={error} onRetry={() => void load()} /></div>}
    <div className="mb-5 grid gap-3 sm:grid-cols-3"><Panel className="p-4"><ShieldAlert className="h-4 w-4 text-red-700" /><p className="mono mt-3 text-2xl">{items.length}</p><p className="mt-1 text-[10px] uppercase tracking-wider text-stone">Held submissions</p></Panel><Panel className="p-4"><EyeOff className="h-4 w-4 text-stone" /><p className="mono mt-3 text-2xl">{items.filter((item) => item.is_anonymous).length}</p><p className="mt-1 text-[10px] uppercase tracking-wider text-stone">Sealed identities</p></Panel><Panel className="p-4"><ShieldCheck className="h-4 w-4 text-emerald-700" /><p className="mt-3 text-xs font-medium">No public or twin mutation</p><p className="mt-1 text-[10px] text-stone">All listed content is held privately</p></Panel></div>
    {loading ? <Spinner label="Loading held submissions" /> : items.length === 0 ? <Panel><EmptyState title="Moderation queue is clear" description="No abusive or harmful submissions are currently held for review." icon={<ShieldCheck className="h-5 w-5" />} /></Panel> : <div className="grid items-start gap-5 lg:grid-cols-[360px_minmax(0,1fr)]"><Panel className="scrollbar-thin max-h-[640px] overflow-y-auto p-2">{items.map((item) => <button key={item.id} onClick={() => setSelectedId(item.id)} className={cx('mb-1 w-full rounded-lg border p-4 text-left', selected?.id === item.id ? 'border-stitch bg-linen shadow-sm' : 'border-transparent hover:bg-linen/60')}><div className="flex items-center justify-between"><StatusBadge status={item.moderation_status} /><span className="text-[9px] text-stone">{formatDate(item.created_at)}</span></div><p className="mt-3 line-clamp-2 text-xs leading-5">{item.submitted_text}</p><p className="mt-2 text-[10px] text-stone">{item.public_reporter_label}</p></button>)}</Panel>
      {selected && <Panel className="p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[9px] uppercase tracking-[.18em] text-stone">Held submission · {selected.id}</p><h2 className="mt-2 text-lg font-semibold">Private moderation record</h2></div><StatusBadge status={selected.moderation_status} /></div><div className="mt-5 rounded-xl border border-red-100 bg-red-50/40 p-5"><p className="text-[9px] font-semibold uppercase tracking-wider text-red-900">Intercepted text</p><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-red-950">{selected.submitted_text}</p></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-lg bg-silk p-3"><p className="text-[9px] uppercase tracking-wider text-stone">Moderation rationale</p><p className="mt-2 text-xs leading-5">{selected.moderation_reason}</p></div><div className="rounded-lg bg-silk p-3"><p className="text-[9px] uppercase tracking-wider text-stone">Public attribution</p><p className="mt-2 text-xs">{selected.public_reporter_label}</p><p className="mono mt-1 text-[10px] text-stone">{selected.space_code ?? 'No resolved space'}</p></div></div>
        {selected.vault_token ? <div className="mt-5 rounded-xl border border-stitch bg-linen p-5"><div className="flex items-start gap-3"><KeyRound className="mt-0.5 h-5 w-5" /><div><p className="text-sm font-medium">Encrypted anonymity record</p><p className="mono mt-2 break-all text-[10px] text-stone">{selected.vault_token}</p></div></div>{user?.role === 'SYSTEM_ADMIN' ? <Button variant="danger" className="mt-4" onClick={() => setUnsealItem(selected)}><KeyRound className="h-4 w-4" />Initiate break-glass unseal</Button> : <div className="mt-4 flex items-center gap-2 rounded-lg bg-white p-3 text-[11px] text-stone"><EyeOff className="h-4 w-4" />Only System Administrator can request identity unsealing. Your role cannot access this control.</div>}</div> : <Badge tone="neutral" className="mt-5">No sealed identity attached</Badge>}
      </Panel>}</div>}
    {unsealItem && <BreakGlassUnsealModal item={unsealItem} onClose={() => setUnsealItem(null)} />}
  </>;
}
