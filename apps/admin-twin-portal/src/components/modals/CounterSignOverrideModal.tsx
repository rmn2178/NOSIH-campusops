import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api } from '../../api/client';
import type { PurchaseRequest } from '../../types';
import { Button, ErrorBanner, Modal } from '../ui';

export function CounterSignOverrideModal({ purchaseRequest, onClose, onCompleted }: {
  purchaseRequest: PurchaseRequest;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [reason, setReason] = useState('');
  const [counterSignUserId, setCounterSignUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await api.inventory.override(purchaseRequest.id, reason.trim(), counterSignUserId.trim()); onCompleted(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Emergency override rejected'); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} title="Dual-role counter-sign override" description={`${purchaseRequest.pr_number} · Emergency cost or budget limit override`}>
    <div className="space-y-5"><div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-950"><ShieldAlert className="h-5 w-5 shrink-0" /><p>This action cannot bypass separation of duties. A distinct Incident Manager or Procurement Approver must counter-sign. The backend records an immutable OVERRIDE audit entry.</p></div>
      {error && <ErrorBanner message={error} />}
      <label className="block text-xs font-medium">Counter-signing user ID<input value={counterSignUserId} onChange={(event) => setCounterSignUserId(event.target.value)} className="mono mt-2 h-11 w-full rounded-lg border border-stitch bg-white px-3 text-sm outline-none focus:border-stone-400" placeholder="Distinct authorizing user ID" /></label>
      <label className="block text-xs font-medium">Formal override reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={4} minLength={20} className="mt-2 w-full rounded-lg border border-stitch bg-white p-3 text-sm leading-6 outline-none focus:border-stone-400" placeholder="Document the emergency and why normal cost or budget constraints must be overridden…" /><span className="mt-1 block text-[10px] text-stone">Minimum 20 characters · {reason.trim().length} entered</span></label>
      <Button className="w-full" disabled={busy || reason.trim().length < 20 || !counterSignUserId.trim()} onClick={() => void submit()}>{busy ? 'Verifying counter-signature…' : 'Submit emergency override'}</Button>
    </div>
  </Modal>;
}
