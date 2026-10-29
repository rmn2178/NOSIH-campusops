import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Inbox, Mail, RefreshCw, Send, Webhook } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, EmptyState, ErrorBanner, PageHeader, Panel, Spinner, StatusBadge, cx, formatDate } from '../components/ui';
import { useAuthStore } from '../store/authStore';
import { usePortalStore } from '../store/portalStore';
import type { NotificationLog } from '../types';

export function ExternalIntegrationsConsole() {
  const { user } = useAuthStore();
  const { twinRevision, invalidateTwin } = usePortalStore();
  const [fromEmail, setFromEmail] = useState(user?.email ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [notifications, setNotifications] = useState<NotificationLog[]>([]);
  const [channel, setChannel] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ complaint_id?: string; moderation_status: string; message: string } | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setNotifications(await api.integrations.notifications()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load notification log'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load, twinRevision]);
  const receive = async () => {
    setSending(true); setError(null); setResult(null);
    try {
      const response = await api.integrations.receiveEmail({ from_email: fromEmail.trim(), subject: subject.trim(), body: body.trim() });
      setResult(response); setSubject(''); setBody('');
      invalidateTwin('Inbound email processed through the live intake pipeline');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Inbound email processing failed'); }
    finally { setSending(false); }
  };
  const filtered = channel === 'ALL' ? notifications : notifications.filter((item) => item.channel === channel);

  return <><PageHeader eyebrow="Workspace 06 · External event pathways" title="Email intake & notification console" description="Submit external email into the same five-stage intake pipeline as portal complaints, then inspect the server-recorded webhook, email and SMS delivery log." />
    {error && <div className="mb-5"><ErrorBanner message={error} /></div>}
    <div className="grid items-start gap-5 xl:grid-cols-[.85fr_1.15fr]"><Panel className="p-5"><div className="flex items-center gap-3"><div className="rounded-lg bg-silk p-2"><Inbox className="h-5 w-5" /></div><div><h2 className="text-sm font-semibold">Inbound email event</h2><p className="mt-1 text-[11px] text-stone">Real API intake through the five-stage pipeline</p></div></div><div className="mt-5 space-y-4"><label className="block text-xs font-medium">From email<input type="email" required value={fromEmail} onChange={(event) => setFromEmail(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-stitch bg-silk px-3 text-sm outline-none focus:bg-white" /></label><label className="block text-xs font-medium">Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-stitch bg-silk px-3 text-sm outline-none focus:bg-white" placeholder="Facilities issue requiring attention" /></label><label className="block text-xs font-medium">Email body<textarea value={body} onChange={(event) => setBody(event.target.value)} rows={7} className="mt-2 w-full rounded-lg border border-stitch bg-silk p-3 text-sm leading-6 outline-none focus:bg-white" placeholder="Projector and fans in B3-02 not working…" /></label><Button className="w-full" disabled={sending || !fromEmail.includes('@') || !subject.trim() || !body.trim()} onClick={() => void receive()}><Send className="h-4 w-4" />{sending ? 'Running five-stage intake…' : 'Receive & process email'}<ArrowRight className="h-4 w-4" /></Button></div>
      {result && <div className="mt-5 animate-slide-in rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-center gap-2 text-emerald-900"><CheckCircle2 className="h-4 w-4" /><p className="text-xs font-semibold">Pipeline response received</p></div><div className="mt-3 flex gap-2"><StatusBadge status={result.moderation_status} />{result.complaint_id && <Badge tone="neutral">{result.complaint_id}</Badge>}</div><p className="mt-3 text-xs leading-5 text-emerald-950">{result.message}</p></div>}
      <div className="mt-5 border-t border-stitch pt-4 text-[10px] leading-5 text-stone">Accepted messages can update the twin immediately. Held content remains private and cannot change campus state.</div>
    </Panel>
      <Panel className="overflow-hidden"><div className="flex flex-col justify-between gap-3 border-b border-stitch p-5 sm:flex-row sm:items-center"><div className="flex items-center gap-2"><Webhook className="h-4 w-4" /><div><h2 className="text-sm font-semibold">Outbound notification log</h2><p className="mt-1 text-[11px] text-stone">Authoritative delivery records</p></div></div><Button size="sm" variant="secondary" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button></div><div className="flex gap-1 border-b border-stitch bg-silk/50 p-3">{['ALL', 'WEBHOOK', 'EMAIL', 'SMS'].map((item) => <button key={item} onClick={() => setChannel(item)} className={cx('rounded-md px-3 py-1.5 text-[9px] font-medium', channel === item ? 'bg-obsidian text-white' : 'text-stone')}>{item}</button>)}</div>
        {loading ? <Spinner label="Loading outbound events" /> : filtered.length === 0 ? <EmptyState title="No notifications in this channel" description="SLA warnings, breaches and intake confirmations will appear after the backend dispatches them." /> : <div className="scrollbar-thin max-h-[650px] divide-y divide-stitch overflow-y-auto">{filtered.map((notification) => <article key={notification.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><Badge tone={notification.channel === 'WEBHOOK' ? 'violet' : notification.channel === 'EMAIL' ? 'cyan' : 'neutral'}>{notification.channel === 'EMAIL' ? <Mail className="h-3 w-3" /> : <Webhook className="h-3 w-3" />}{notification.channel}</Badge><StatusBadge status={notification.status} /></div><span className="text-[9px] text-stone">{formatDate(notification.created_at)}</span></div><p className="mt-3 text-xs font-medium">{notification.subject ?? notification.recipient}</p><p className="mt-1 text-[10px] text-stone">To · {notification.recipient}</p><pre className="mono scrollbar-thin mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-silk p-3 text-[9px] leading-4 text-stone">{typeof notification.payload === 'string' ? notification.payload : JSON.stringify(notification.payload, null, 2)}</pre>{notification.related_resource_id && <p className="mono mt-2 text-[9px] text-stone">Resource · {notification.related_resource_id}</p>}</article>)}</div>}
      </Panel></div>
  </>;
}
