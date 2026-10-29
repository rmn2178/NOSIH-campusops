import { useState } from 'react';
import { Eye, KeyRound, ShieldAlert } from 'lucide-react';
import { api } from '../../api/client';
import type { ModerationItem } from '../../types';
import { Badge, Button, ErrorBanner, Modal } from '../ui';

interface UnsealedIdentity {
  user_id: string;
  email: string;
  full_name: string;
  department_code?: string;
  year_number?: number;
}

export function BreakGlassUnsealModal({ item, onClose }: { item: ModerationItem; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [policy, setPolicy] = useState<'THREAT_TO_LIFE_SAFETY' | 'SEVERE_HARASSMENT_INVESTIGATION'>('THREAT_TO_LIFE_SAFETY');
  const [identity, setIdentity] = useState<UnsealedIdentity | null>(null);
  const [auditId, setAuditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unseal = async () => {
    if (!item.vault_token) return;
    setBusy(true); setError(null);
    try { const result = await api.moderation.unseal(item.vault_token, reason.trim(), policy); setIdentity(result.identity); setAuditId(result.audit_entry_id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Break-glass request rejected'); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} title="Break-glass identity unseal" description="Restricted to System Administrator · audited before decryption">
    <div className="space-y-5">{identity ? <div className="animate-slide-in"><div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4"><Eye className="h-5 w-5 text-red-800" /><div><p className="text-sm font-semibold text-red-950">Sealed identity disclosed</p><p className="mt-1 text-[11px] text-red-900">This access is permanently recorded in the BREAK_GLASS audit ledger.</p></div></div><dl className="mt-4 space-y-2 rounded-xl border border-stitch bg-white p-4 text-xs">{[['Full name', identity.full_name], ['Institutional email', identity.email], ['User ID', identity.user_id], ['Department', identity.department_code ?? '—'], ['Year', identity.year_number?.toString() ?? '—']].map(([label, value]) => <div key={label} className="flex justify-between gap-4 border-b border-stitch pb-2 last:border-0 last:pb-0"><dt className="text-stone">{label}</dt><dd className="mono text-right font-medium">{value}</dd></div>)}</dl>{auditId && <p className="mono mt-3 text-[10px] text-stone">Audit entry · {auditId}</p>}<Button className="mt-5 w-full" onClick={onClose}>Close protected identity</Button></div> : <>
      <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4"><ShieldAlert className="h-5 w-5 shrink-0 text-red-800" /><div><p className="text-sm font-medium text-red-950">Exceptional privacy access</p><p className="mt-1 text-xs leading-5 text-red-900">Use only for an imminent safety threat or severe harassment investigation. The server writes the immutable audit entry before decrypting identity.</p></div></div>
      <div className="rounded-lg bg-silk p-3"><p className="text-[9px] uppercase tracking-wider text-stone">Vault token</p><p className="mono mt-1 break-all text-[10px]">{item.vault_token}</p></div>
      {error && <ErrorBanner message={error} />}
      <label className="block text-xs font-medium">Policy clause<select value={policy} onChange={(event) => setPolicy(event.target.value as typeof policy)} className="mt-2 h-11 w-full rounded-lg border border-stitch bg-white px-3 text-xs"><option value="THREAT_TO_LIFE_SAFETY">Threat to life / safety</option><option value="SEVERE_HARASSMENT_INVESTIGATION">Severe harassment investigation</option></select></label>
      <label className="block text-xs font-medium">Formal justification<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={25} rows={4} className="mt-2 w-full rounded-lg border border-stitch bg-white p-3 text-sm leading-6 outline-none focus:border-stone-400" placeholder="State the verified circumstances and investigative need…" /><span className="mt-1 block text-[10px] text-stone">Minimum 25 characters · {reason.trim().length} entered</span></label>
      <Button variant="danger" className="h-11 w-full" disabled={busy || reason.trim().length < 25 || !item.vault_token} onClick={() => void unseal()}><KeyRound className="h-4 w-4" />{busy ? 'Recording audit & decrypting…' : 'Unseal protected identity'}<Badge tone="red">BREAK GLASS</Badge></Button>
    </>}</div>
  </Modal>;
}
