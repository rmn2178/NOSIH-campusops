import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Check, ChevronDown, Package, PackageCheck, RefreshCw, ShieldCheck, Truck, X } from 'lucide-react';
import { ApiError, api } from '../api/client';
import { CounterSignOverrideModal } from '../components/modals/CounterSignOverrideModal';
import { Badge, Button, CheckItem, EmptyState, ErrorBanner, PageHeader, Panel, Spinner, StatusBadge, cx, formatDate, formatINR } from '../components/ui';
import { useAuthStore } from '../store/authStore';
import { usePortalStore } from '../store/portalStore';
import type { ApprovalPreflight, InventoryItem, PartRequest, PurchaseRequest, WorkOrder } from '../types';

function rejectionMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'Request rejected';
  if (typeof error.body === 'object' && error.body !== null) {
    const body = error.body as { rule_fired?: string; detail?: { rule_fired?: string } | string };
    const rule = body.rule_fired ?? (typeof body.detail === 'object' ? body.detail?.rule_fired : undefined);
    return rule ? `${error.message} · Violated rule: ${rule}` : error.message;
  }
  return error.message;
}

export function InventoryProcurementView() {
  const { user } = useAuthStore();
  const { twinRevision, invalidateTwin } = usePortalStore();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [requests, setRequests] = useState<PurchaseRequest[]>([]);
  const [blocked, setBlocked] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Record<string, ApprovalPreflight>>({});
  const [overridePr, setOverridePr] = useState<PurchaseRequest | null>(null);
  const [receivePr, setReceivePr] = useState<PurchaseRequest | null>(null);
  const [receivedParts, setReceivedParts] = useState<PartRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const [inventoryData, requestData, orderData] = await Promise.all([api.inventory.list(), api.inventory.purchaseRequests(), api.workOrders.list()]); setItems(inventoryData); setRequests(requestData); setBlocked(orderData.filter((order) => order.status === 'BLOCKED_PARTS')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load inventory'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load, twinRevision]);
  const filtered = useMemo(() => items.filter((item) => `${item.sku_code} ${item.name} ${item.category}`.toLowerCase().includes(search.toLowerCase())), [items, search]);
  const chartData = useMemo(() => [...items].sort((a, b) => a.available_qty - b.available_qty).slice(0, 8).map((item) => ({ sku: item.sku_code.replace('SKU-', ''), available: item.available_qty, reserved: item.reserved_qty })), [items]);
  const canApprove = user && ['FACILITIES_ADMIN', 'PROCUREMENT_APPROVER'].includes(user.role);

  const togglePreflight = async (pr: PurchaseRequest) => {
    if (expanded === pr.id) { setExpanded(null); return; }
    setExpanded(pr.id); setError(null);
    try { const result = await api.inventory.approvalPreflight(pr.id); setPreflight((current) => ({ ...current, [pr.id]: result })); }
    catch (reason) { setError(rejectionMessage(reason)); }
  };
  const approve = async (pr: PurchaseRequest) => {
    setBusy(pr.id); setError(null);
    try { await api.inventory.approve(pr.id); invalidateTwin('Purchase request approved and audit trail updated'); await load(); }
    catch (reason) { setError(rejectionMessage(reason)); }
    finally { setBusy(null); }
  };
  const receive = async () => {
    if (!receivePr) return;
    setBusy(receivePr.id); setError(null);
    try { await api.inventory.receiveStock(receivePr.id, receivedParts); setReceivePr(null); invalidateTwin('Stock received; waiting work orders and SLA clocks reevaluated'); await load(); }
    catch (reason) { setError(rejectionMessage(reason)); }
    finally { setBusy(null); }
  };

  return <><PageHeader eyebrow="Workspace 03 · Material constraints" title="Inventory & procurement approvals" description="Atomic stock reservations, explicit parts shortages, separation of duties and role-based cost authority—without partial or self-approved transactions." actions={<Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>} />
    {error && <div className="mb-5"><ErrorBanner message={error} /></div>}
    {loading && items.length === 0 ? <Spinner label="Loading stock and purchase requests" /> : <>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
        ['Catalogued SKUs', items.length, Package], ['Available units', items.reduce((sum, item) => sum + item.available_qty, 0), PackageCheck],
        ['Below reorder level', items.filter((item) => item.available_qty <= item.reorder_level).length, AlertTriangle], ['Blocked work orders', blocked.length, Truck],
      ].map(([label, value, Icon]) => { const IconComponent = Icon as typeof Package; return <Panel key={String(label)} className="flex items-center gap-4 p-4"><div className="rounded-lg bg-silk p-2.5 text-stone"><IconComponent className="h-5 w-5" /></div><div><p className="mono text-2xl font-medium">{String(value)}</p><p className="mt-1 text-[10px] uppercase tracking-wider text-stone">{String(label)}</p></div></Panel>; })}</div>
      <div className="grid items-start gap-5 xl:grid-cols-[1.2fr_.8fr]">
        <Panel className="overflow-hidden"><div className="flex flex-col justify-between gap-3 border-b border-stitch p-5 sm:flex-row sm:items-center"><div><h2 className="text-sm font-semibold">Live spare-parts ledger</h2><p className="mt-1 text-[11px] text-stone">Available = on hand − reserved</p></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search 30 SKUs…" className="h-9 rounded-lg border border-stitch bg-silk px-3 text-xs outline-none focus:bg-white sm:w-52" /></div>
          <div className="scrollbar-thin max-h-[440px] overflow-auto"><table className="w-full min-w-[680px] border-collapse text-left"><thead className="sticky top-0 bg-silk text-[9px] uppercase tracking-wider text-stone"><tr>{['SKU / Part', 'On hand', 'Reserved', 'Available', 'Reorder', 'Unit cost'].map((heading) => <th key={heading} className="px-4 py-3 font-medium">{heading}</th>)}</tr></thead><tbody className="divide-y divide-stitch">{filtered.map((item) => <tr key={item.sku_code} className="text-xs hover:bg-linen"><td className="px-4 py-3"><p className="mono text-[10px] font-semibold">{item.sku_code}</p><p className="mt-1 text-[11px] text-stone">{item.name}</p></td><td className="mono px-4 py-3">{item.on_hand_qty}</td><td className="mono px-4 py-3">{item.reserved_qty}</td><td className="px-4 py-3"><Badge tone={item.available_qty === 0 ? 'red' : item.available_qty <= item.reorder_level ? 'amber' : 'green'}>{item.available_qty} {item.unit}</Badge></td><td className="mono px-4 py-3">{item.reorder_level}</td><td className="px-4 py-3 text-[11px]">{formatINR(item.unit_cost_inr)}</td></tr>)}</tbody></table>{filtered.length === 0 && <EmptyState title="No matching SKUs" description="Try a different part code, name, or category." />}</div>
          {chartData.length > 0 && <div className="border-t border-stitch p-5"><p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-stone">Lowest stock positions</p><div className="h-48"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}><CartesianGrid vertical={false} stroke="#ECE9E2" /><XAxis dataKey="sku" tick={{ fontSize: 8, fill: '#63615C' }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 9, fill: '#63615C' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #E6E4DC', fontSize: 11 }} /><Bar dataKey="available" fill="#86EFAC" radius={[4, 4, 0, 0]} /><Bar dataKey="reserved" fill="#C4B5FD" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div></div>}
        </Panel>
        <div className="space-y-5"><Panel className="p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Purchase request approvals</h2><Badge tone="amber">{requests.filter((pr) => pr.status === 'PENDING_APPROVAL').length} pending</Badge></div><p className="mt-1 text-[11px] leading-5 text-stone">Facilities Admin ≤ ₹10,000 · Procurement Approver ≤ ₹100,000 · higher values require both roles.</p><div className="mt-4 space-y-3">{requests.length === 0 ? <EmptyState title="No purchase requests" description="Stock-outs create purchase requests automatically on the backend." /> : requests.map((pr) => <article key={pr.id} className="rounded-xl border border-stitch bg-[#fdfcf9] p-4"><div className="flex items-start justify-between gap-2"><div><button onClick={() => void togglePreflight(pr)} className="mono flex items-center gap-1.5 text-[11px] font-semibold">{pr.pr_number}<ChevronDown className={cx('h-3.5 w-3.5 transition', expanded === pr.id && 'rotate-180')} /></button><p className="mt-1 text-[10px] text-stone">Requested by {pr.requested_by_name} · {pr.department_code}</p></div><StatusBadge status={pr.status} /></div><p className="mt-3 text-lg font-semibold tracking-tight">{formatINR(pr.total_cost_inr)}</p><div className="mt-2 space-y-1">{pr.items.map((item) => <p key={item.sku_code} className="mono text-[9px] text-stone">{item.quantity} × {item.sku_code} {item.item_name ? `· ${item.item_name}` : ''}</p>)}</div>
          {expanded === pr.id && <div className="mt-3 space-y-2 border-t border-stitch pt-3">{preflight[pr.id] ? preflight[pr.id].checks.map((check) => <CheckItem key={check.rule} passed={check.passed} label={check.label || check.rule} detail={check.detail} />) : <Spinner label="Evaluating five approval rules" />}</div>}
          <div className="mt-3 flex flex-wrap gap-2">{canApprove && pr.status === 'PENDING_APPROVAL' && <><Button size="sm" disabled={busy === pr.id} onClick={() => void approve(pr)}><Check className="h-3.5 w-3.5" />{busy === pr.id ? 'Submitting…' : 'Approve'}</Button><Button size="sm" variant="secondary" onClick={() => setOverridePr(pr)}><ShieldCheck className="h-3.5 w-3.5" />Override</Button></>}{canApprove && ['APPROVED', 'ORDERED'].includes(pr.status) && <Button size="sm" variant="secondary" onClick={() => { setReceivePr(pr); setReceivedParts(pr.items.map(({ sku_code, quantity }) => ({ sku_code, quantity }))); }}><Truck className="h-3.5 w-3.5" />Receive stock shipment</Button>}</div><p className="mt-2 text-[9px] text-stone">Created {formatDate(pr.created_at)}</p></article>)}</div></Panel>
          <Panel className="p-5"><h2 className="text-sm font-semibold">Blocked on parts</h2><p className="mt-1 text-[11px] text-stone">SLA clocks are paused while these work orders await stock.</p><div className="mt-3 space-y-2">{blocked.length === 0 ? <p className="py-4 text-xs text-stone">No work orders are currently blocked.</p> : blocked.map((order) => <div key={order.id} className="flex items-center justify-between rounded-lg border border-purple-200 bg-purple-50 p-3"><div><p className="mono text-[10px] font-medium">{order.work_order_number}</p><p className="mt-1 text-[10px] text-purple-800">{order.space_code}</p></div><StatusBadge status={order.status} /></div>)}</div></Panel></div>
      </div>
    </>}
    {overridePr && <CounterSignOverrideModal purchaseRequest={overridePr} onClose={() => setOverridePr(null)} onCompleted={() => { invalidateTwin('Emergency procurement override recorded'); void load(); }} />}
    {receivePr && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/25 p-4 backdrop-blur-sm"><Panel className="w-full max-w-lg p-6"><div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">Receive stock shipment</h2><p className="mt-1 text-xs text-stone">{receivePr.pr_number} · Confirm actual received quantities</p></div><Button size="icon" variant="ghost" onClick={() => setReceivePr(null)}><X className="h-4 w-4" /></Button></div><div className="mt-5 space-y-3">{receivedParts.map((part, index) => <div key={part.sku_code} className="flex items-center gap-3 rounded-lg border border-stitch p-3"><div className="flex-1"><p className="mono text-xs">{part.sku_code}</p><p className="mt-1 text-[10px] text-stone">Ordered {receivePr.items.find((item) => item.sku_code === part.sku_code)?.quantity ?? part.quantity}</p></div><input aria-label={`Received quantity ${part.sku_code}`} type="number" min="0" value={part.quantity} onChange={(event) => setReceivedParts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Math.max(0, Number(event.target.value)) } : item))} className="mono h-9 w-24 rounded-lg border border-stitch bg-silk px-2 text-right text-xs" /></div>)}</div><div className="mt-4 rounded-lg bg-silk p-3 text-[11px] leading-5 text-stone">The backend allocates newly received stock to blocked work orders by priority and resumes only the SLA clocks it can fully satisfy.</div><Button className="mt-5 w-full" disabled={busy === receivePr.id} onClick={() => void receive()}>{busy === receivePr.id ? 'Receiving & reallocating…' : 'Confirm receipt & unblock work orders'}</Button></Panel></div>}
  </>;
}
