import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Clock3, HardHat, LoaderCircle, MessageCircle, ShieldQuestion, Users } from 'lucide-react';
import { api } from '../api/client';
import type { Complaint } from '../api/client';
import { CommentThread } from '../components/CommentThread';
import { StatusPill, toneForStatus } from '../components/StatusPill';
import { areaLabel, cx, formatDate, slaLabel, statusLabel, twinLabel, urgencyLabel } from '../lib/format';

export function ComplaintDetailPage() {
  const { complaintId } = useParams<{ complaintId: string }>();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [voting, setVoting] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!complaintId) return;
    setLoading(true);
    setError('');
    try {
      setComplaint(await api.getComplaint(complaintId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load this complaint.');
    } finally {
      setLoading(false);
    }
  }, [complaintId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!loading && complaint && hash === '#comments') {
      threadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [complaint, hash, loading]);

  const confirmAffected = async () => {
    if (!complaint) return;
    setVoting(true);
    setError('');
    try {
      setComplaint(await api.confirmAffected(complaint.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to confirm that you are affected.');
    } finally {
      setVoting(false);
    }
  };

  if (loading) {
    return <div className="mx-auto flex max-w-[1100px] items-center justify-center gap-3 px-4 py-24 text-sm text-stone" role="status"><LoaderCircle size={18} className="animate-spin" /> Loading complaint…</div>;
  }

  if (!complaint) {
    const friendly = error.includes('COMPLAINT_NOT_FOUND')
      ? 'We could not find that ticket. It may have been merged into another report or removed.'
      : error || 'The ticket may have been removed, merged, or belongs to another campus view.';
    return (
      <div className="mx-auto max-w-[1100px] px-4 py-16 sm:px-6 lg:px-10">
        <div className="cloth-card flex flex-col items-center px-6 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-stitch bg-silk text-stone"><ShieldQuestion size={25} strokeWidth={1.4} /></span>
          <h1 className="mt-5 text-lg font-semibold">This complaint is not available</h1>
          <p className="mt-2 max-w-sm text-sm leading-6 text-stone">{friendly}</p>
          <Link to="/feed" className="btn-primary mt-5"><ArrowLeft size={16} /> Back to the feed</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <button type="button" onClick={() => navigate('/feed')} className="flex items-center gap-1.5 text-xs font-medium text-stone transition hover:text-ink">
        <ArrowLeft size={15} /> Campus feed
      </button>

      <motion.header initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="eyebrow">Complaint record</p>
          <span className="mono text-xs font-semibold">{complaint.ticket_number}</span>
          <span className="mono rounded-lg border border-stitch bg-silk px-2 py-1 text-[10px] font-semibold">{complaint.space_code}</span>
          <StatusPill label={urgencyLabel(complaint.urgency)} tone={toneForStatus(complaint.urgency)} />
          <time className="ml-auto text-[10px] text-stone" dateTime={complaint.created_at}>{formatDate(complaint.created_at)}</time>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">{complaint.space_name ?? complaint.space_code} facilities report</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-stone">Full record, live response state and the community thread for this ticket.</p>
      </motion.header>

      <div className="mt-7 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <section className="cloth-card p-5 sm:p-6" aria-label="Complaint summary">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={twinLabel(complaint.twin_state)} tone={toneForStatus(complaint.twin_state)} dot />
            <StatusPill label={statusLabel(complaint.status)} tone={toneForStatus(complaint.status)} />
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-stone"><Clock3 size={12} /><span className="mono">{slaLabel(complaint)}</span></span>
          </div>

          <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-ink">{complaint.description}</p>

          {complaint.photo_url && (
            <a href={complaint.photo_url} target="_blank" rel="noreferrer" className="mt-4 block overflow-hidden rounded-xl border border-stitch bg-silk">
              <img src={complaint.photo_url} alt={`Evidence for ${complaint.ticket_number}`} className="max-h-64 w-full object-cover" loading="lazy" />
            </a>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-stitch bg-white px-2.5 py-1 text-[10px] font-medium text-stone">{complaint.category.replaceAll('_', ' ')}</span>
            {complaint.target_assets.map((asset) => (
              <span key={asset.asset_code} className="mono rounded-full border border-stitch bg-silk px-2.5 py-1 text-[9px] text-stone">{asset.asset_code}</span>
            ))}
          </div>

          {complaint.parent_ticket_number && (
            <p className="mt-4 rounded-xl border border-purple-200 bg-purple-50 px-3 py-2 text-[11px] text-purple-800">Merged into <span className="mono font-semibold">{complaint.parent_ticket_number}</span>; community confirmations raise the active ticket’s priority.</p>
          )}

          {complaint.officer?.full_name && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-stitch bg-silk/60 px-3 py-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-stitch bg-white"><HardHat size={14} className="text-stone" /></span>
              <div className="min-w-0">
                <p className="text-xs font-semibold">{complaint.officer.full_name}</p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-stone">
                  Area officer · {complaint.officer.primary_skill} · {areaLabel(complaint.officer.area)}
                </p>
              </div>
              {complaint.officer.work_order_number && (
                <span className="mono ml-auto rounded-lg border border-stitch bg-white px-2 py-1 text-[10px] text-stone">{complaint.officer.work_order_number}</span>
              )}
            </div>
          )}

          <div className="mt-5 flex items-center gap-2 border-t border-stitch pt-4">
            <span className={cx('flex h-8 w-8 items-center justify-center rounded-full border border-stitch', complaint.is_anonymous ? 'bg-silk' : 'bg-white')}><Users size={14} className="text-stone" /></span>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{complaint.reporter_label}</p>
              <p className="mt-0.5 text-[9px] uppercase tracking-wider text-stone">{complaint.is_anonymous ? 'Vault protected' : 'Verified reporter'}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void confirmAffected()}
              disabled={voting || complaint.viewer_has_voted || complaint.status === 'RESOLVED'}
              className="btn-secondary px-3 py-2.5 text-xs"
              title={complaint.viewer_has_voted ? 'You already confirmed this issue' : 'Confirm that this issue affects you'}
            >
              {voting ? <LoaderCircle size={15} className="animate-spin" /> : <Users size={15} />}
              {complaint.viewer_has_voted ? 'Affected confirmed' : 'I’m affected too'}
              <span className="mono rounded-full bg-silk px-2 py-0.5 text-[10px]">+{complaint.affected_count}</span>
            </button>
            <a href="#comments" className="btn-secondary px-3 py-2.5 text-xs"><MessageCircle size={15} /> Open thread <span className="mono rounded-full bg-silk px-2 py-0.5 text-[10px]">{complaint.comment_count}</span></a>
          </div>

          {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}
        </section>

        <section ref={threadRef} id="comments" className="cloth-card flex max-h-[76vh] min-h-[420px] flex-col overflow-hidden scroll-mt-24" aria-label="Community thread">
          <div className="flex items-center gap-2 border-b border-stitch px-5 py-4">
            <MessageCircle size={16} />
            <h2 className="text-sm font-semibold">Community thread</h2>
            <span className="mono ml-auto rounded-full bg-silk px-2 py-0.5 text-[10px]">{complaint.comment_count}</span>
          </div>
          <CommentThread complaint={complaint} onCommentAdded={() => setComplaint((current) => current ? { ...current, comment_count: current.comment_count + 1 } : current)} />
        </section>
      </div>
    </div>
  );
}
