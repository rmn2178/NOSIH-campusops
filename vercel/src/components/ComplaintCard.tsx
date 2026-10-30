import { forwardRef } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, Clock3, Image as ImageIcon, LoaderCircle, MessageCircle, Users } from 'lucide-react';
import type { Complaint } from '../api/client';
import { formatDate, slaLabel, statusLabel, twinLabel, urgencyLabel } from '../lib/format';
import { StatusPill, toneForStatus } from './StatusPill';

interface ComplaintCardProps {
  complaint: Complaint;
  voting: boolean;
  onAffected: (complaint: Complaint) => void;
  onComments: (complaint: Complaint) => void;
}

// forwardRef: AnimatePresence popLayout measures this card through a ref.
export const ComplaintCard = forwardRef<HTMLElement, ComplaintCardProps>(function ComplaintCard(
  { complaint, voting, onAffected, onComments },
  ref,
) {
  return (
    <motion.article
      ref={ref}
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.24 }}
      className="cloth-card overflow-hidden transition hover:shadow-lift"
    >
      {complaint.photo_url && (
        <a href={complaint.photo_url} target="_blank" rel="noreferrer" className="group relative block h-44 overflow-hidden border-b border-stitch bg-silk" aria-label={`Open evidence for ${complaint.ticket_number}`}>
          <img src={complaint.photo_url} alt={`Evidence for ${complaint.ticket_number}`} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.025]" loading="lazy" />
          <span className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-lg bg-white/90 text-ink shadow-sm backdrop-blur"><ArrowUpRight size={15} /></span>
        </a>
      )}
      <div className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono text-xs font-semibold tracking-tight">{complaint.ticket_number}</span>
          <span className="mono rounded-lg border border-stitch bg-silk px-2 py-1 text-[10px] font-semibold">{complaint.space_code}</span>
          <StatusPill label={urgencyLabel(complaint.urgency)} tone={toneForStatus(complaint.urgency)} />
          <time className="ml-auto text-[10px] text-stone" dateTime={complaint.created_at}>{formatDate(complaint.created_at)}</time>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusPill label={twinLabel(complaint.twin_state)} tone={toneForStatus(complaint.twin_state)} dot />
          <StatusPill label={statusLabel(complaint.status)} tone={toneForStatus(complaint.status)} />
        </div>

        <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-ink">{complaint.description}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-stitch bg-white px-2.5 py-1 text-[10px] font-medium text-stone">{complaint.category.replaceAll('_', ' ')}</span>
          {complaint.target_assets.slice(0, 4).map((asset) => (
            <span key={asset.asset_code} className="mono rounded-full border border-stitch bg-silk px-2.5 py-1 text-[9px] text-stone">{asset.asset_code}</span>
          ))}
          {complaint.target_assets.length > 4 && <span className="text-[10px] text-stone">+{complaint.target_assets.length - 4} assets</span>}
        </div>

        {complaint.parent_ticket_number && (
          <p className="mt-4 rounded-xl border border-purple-200 bg-purple-50 px-3 py-2 text-[11px] text-purple-800">Merged into <span className="mono font-semibold">{complaint.parent_ticket_number}</span>; community confirmations raise the active ticket’s priority.</p>
        )}

        <div className="mt-5 flex items-center gap-2 border-t border-stitch pt-4">
          <span className={`flex h-7 w-7 items-center justify-center rounded-full border border-stitch ${complaint.is_anonymous ? 'bg-silk' : 'bg-white'}`}>
            {complaint.photo_url ? <ImageIcon size={13} className="text-stone" /> : <Users size={13} className="text-stone" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium">{complaint.reporter_label}</p>
            <p className="mt-0.5 text-[9px] uppercase tracking-wider text-stone">{complaint.is_anonymous ? 'Vault protected' : 'Verified reporter'}</p>
          </div>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-stone"><Clock3 size={12} /><span className="mono">{slaLabel(complaint)}</span></span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-t border-stitch bg-stitch">
        <button
          type="button"
          onClick={() => onAffected(complaint)}
          disabled={voting || complaint.viewer_has_voted || complaint.status === 'RESOLVED'}
          className="flex items-center justify-center gap-2 bg-white px-3 py-3.5 text-xs font-medium transition hover:bg-silk disabled:cursor-not-allowed disabled:bg-silk/50 disabled:text-stone"
          title={complaint.viewer_has_voted ? 'You already confirmed this issue' : 'Confirm that this issue affects you'}
        >
          {voting ? <LoaderCircle size={15} className="animate-spin" /> : <Users size={15} />}
          {complaint.viewer_has_voted ? 'Affected confirmed' : 'I’m affected too'}
          <span className="mono rounded-full bg-silk px-2 py-0.5 text-[10px]">+{complaint.affected_count}</span>
        </button>
        <button type="button" onClick={() => onComments(complaint)} className="flex items-center justify-center gap-2 bg-white px-3 py-3.5 text-xs font-medium transition hover:bg-silk">
          <MessageCircle size={15} /> Comments <span className="mono rounded-full bg-silk px-2 py-0.5 text-[10px]">{complaint.comment_count}</span>
        </button>
      </div>
    </motion.article>
  );
});
