import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LoaderCircle, MessageCircle, Send, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import type { Complaint, ComplaintComment, ModerationRejectedResponse } from '../api/client';
import { connectPortalSocket } from '../api/websocket';
import { formatDate } from '../lib/format';
import { useAuthStore } from '../store/useAuthStore';
import { AnonymousSwitch } from './AnonymousSwitch';

interface CommentThreadProps {
  complaint: Complaint;
  onCommentAdded?: (complaintId: string, commentId: string) => void;
}

/**
 * Live comment thread for one complaint: loaded list, realtime appends and a
 * moderated composer. Rendered inline on the detail page and inside the drawer.
 */
export function CommentThread({ complaint, onCommentAdded }: CommentThreadProps) {
  const token = useAuthStore((state) => state.token);
  const [comments, setComments] = useState<ComplaintComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [moderation, setModeration] = useState<ModerationRejectedResponse | null>(null);
  const [originalText, setOriginalText] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.listComments(complaint.id)
      .then((items) => {
        if (active) setComments(items);
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Unable to load comments.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [complaint.id]);

  useEffect(() => {
    if (!token) return;
    return connectPortalSocket(token, (event) => {
      if (event.type === 'COMMENT_CREATED' && event.comment?.complaint_id === complaint.id) {
        setComments((current) => current.some((comment) => comment.id === event.comment?.id)
          ? current
          : [...current, event.comment!]);
      }
    }, () => undefined);
  }, [complaint.id, token]);

  const submitComment = useCallback(async (text: string) => {
    const cleanText = text.trim();
    if (!cleanText) return;
    setSubmitting(true);
    setError('');
    setModeration(null);
    try {
      const result = await api.createComment(complaint.id, cleanText, isAnonymous);
      if (result.moderation_status === 'APPROVED') {
        setComments((current) => current.some((comment) => comment.id === result.comment.id)
          ? current
          : [...current, result.comment]);
        setBody('');
        setModeration(null);
        setOriginalText('');
        onCommentAdded?.(complaint.id, result.comment.id);
      } else {
        setOriginalText(cleanText);
        setModeration(result);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to post your comment.');
    } finally {
      setSubmitting(false);
    }
  }, [complaint.id, isAnonymous, onCommentAdded]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submitComment(body);
  };

  return (
    <>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-stone"><LoaderCircle size={17} className="animate-spin" /> Loading comments…</div>
        ) : comments.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-stitch bg-white/50 px-6 text-center">
            <MessageCircle size={24} strokeWidth={1.4} className="text-stone" />
            <p className="mt-3 text-sm font-medium">No comments yet</p>
            <p className="mt-1 text-xs leading-5 text-stone">Share a useful update or confirm what you observed.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {comments.map((comment) => (
              <motion.article key={comment.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-stitch bg-white p-4 shadow-cloth">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold">{comment.author_label}</span>
                  <span className="rounded-full border border-stitch bg-silk px-2 py-0.5 text-[9px] uppercase tracking-wider text-stone">{comment.is_anonymous ? 'Anonymous' : 'Named'}</span>
                  <time className="ml-auto text-[10px] text-stone" dateTime={comment.created_at}>{formatDate(comment.created_at)}</time>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink">{comment.body}</p>
              </motion.article>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-stitch bg-white px-5 py-5">
        <AnimatePresence mode="wait">
          {moderation && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 overflow-hidden">
              {moderation.moderation_status === 'NEEDS_REWRITE' && moderation.suggested_polite_rewrite ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <p className="flex items-center gap-2 text-xs font-semibold text-amber-950"><Sparkles size={14} /> A respectful rewrite is ready</p>
                  <p className="mt-2 text-xs leading-5 text-amber-900">{moderation.suggested_polite_rewrite}</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => { setBody(originalText); setModeration(null); }}>Edit original</button>
                    <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={submitting} onClick={() => void submitComment(moderation.suggested_polite_rewrite || '')}>Use & post rewrite</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-xs leading-5 text-red-800">
                  <ShieldAlert size={17} className="shrink-0" />
                  <p>{moderation.message || 'This comment was held by moderation and was not published.'}</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <form onSubmit={handleSubmit}>
          <AnonymousSwitch value={isAnonymous} onChange={setIsAnonymous} compact disabled={submitting} />
          <label htmlFor={`new-comment-${complaint.id}`} className="sr-only">Write a comment</label>
          <textarea
            id={`new-comment-${complaint.id}`}
            className="field mt-3 min-h-24 resize-none bg-silk text-sm leading-6"
            value={body}
            maxLength={2000}
            disabled={submitting}
            onChange={(event) => {
              setBody(event.target.value);
              setError('');
              setModeration(null);
            }}
            placeholder="Add a useful observation or update…"
          />
          {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
          <div className="mt-3 flex items-center gap-3">
            <p className="flex flex-1 items-center gap-1.5 text-[10px] leading-4 text-stone"><ShieldCheck size={13} className="shrink-0" /> Moderated before publication</p>
            <button type="submit" className="btn-primary px-4 py-2.5" disabled={submitting || !body.trim()}>
              {submitting ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}
              {submitting ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
