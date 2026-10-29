import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, Check, CheckCircle2, Clock3, GitMerge, LoaderCircle, MapPin, Send, Sparkles, Wrench } from 'lucide-react';
import { api } from '../api/client';
import type { Complaint, FirstResponse, SupplementResponse } from '../api/client';
import { urgencyLabel } from '../lib/format';
import { StatusPill, toneForStatus } from './StatusPill';

interface AiFirstResponseCardProps {
  complaint: Complaint;
  response: FirstResponse;
  onUpdated: (result: SupplementResponse) => void;
}

export function AiFirstResponseCard({ complaint, response, onUpdated }: AiFirstResponseCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submitAnswers = async () => {
    const payload = Object.entries(answers)
      .filter(([, answer]) => answer.trim())
      .map(([question, answer]) => ({ question, answer: answer.trim() }));
    if (payload.length === 0) {
      setError('Answer at least one follow-up question before sending.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const updated = await api.supplementComplaint(complaint.id, { answers: payload });
      onUpdated(updated);
      setAnswers({});
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save your answers.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-cloth"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-emerald-100 bg-emerald-50/70 px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-emerald-800 shadow-sm"><Sparkles size={17} /></span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-emerald-950">AI first response</h3>
          <p className="mt-0.5 text-xs text-emerald-800">Your verified report is now with the campus response system.</p>
        </div>
        <StatusPill label={complaint.ticket_number} tone="mint" className="mono" />
      </div>

      <div className="grid gap-px bg-stitch sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-white p-4">
          <MapPin size={15} className="mb-2 text-stone" />
          <p className="text-[10px] uppercase tracking-wider text-stone">Extracted space</p>
          <p className="mono mt-1 text-sm font-semibold">{response.space_code}</p>
          {response.block_floor && <p className="mt-1 text-[11px] text-stone">{response.block_floor}</p>}
        </div>
        <div className="bg-white p-4">
          <Wrench size={15} className="mb-2 text-stone" />
          <p className="text-[10px] uppercase tracking-wider text-stone">Fault category</p>
          <p className="mt-1 text-sm font-semibold">{response.category.replaceAll('_', ' ')}</p>
          <p className="mt-1 text-[11px] text-stone">{response.target_assets.length} asset{response.target_assets.length === 1 ? '' : 's'} identified</p>
        </div>
        <div className="bg-white p-4">
          <p className="text-[10px] uppercase tracking-wider text-stone">Urgency</p>
          <StatusPill label={urgencyLabel(response.urgency)} tone={toneForStatus(response.urgency)} dot className="mt-2" />
        </div>
        <div className="bg-white p-4">
          <Clock3 size={15} className="mb-2 text-stone" />
          <p className="text-[10px] uppercase tracking-wider text-stone">SLA target</p>
          <p className="mono mt-1 text-sm font-semibold">{response.sla_target_minutes >= 60 ? `${Math.floor(response.sla_target_minutes / 60)}h ${response.sla_target_minutes % 60}m` : `${response.sla_target_minutes} min`}</p>
        </div>
      </div>

      {response.target_assets.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-stitch px-5 py-4">
          {response.target_assets.map((asset) => (
            <span key={asset.asset_code} className="mono rounded-lg border border-stitch bg-silk px-2.5 py-1.5 text-[10px]">{asset.asset_code}</span>
          ))}
        </div>
      )}

      {response.merged_duplicate && (
        <div className="mx-5 mt-5 flex items-start gap-3 rounded-xl border border-purple-200 bg-purple-50 p-4">
          <GitMerge size={18} className="mt-0.5 shrink-0 text-purple-800" />
          <div className="text-sm text-purple-950">
            <p className="font-semibold">Merged with an active campus report</p>
            <p className="mt-1 text-xs leading-5 text-purple-800">
              Your report boosted {response.parent_ticket_number || 'the parent ticket'}
              {response.affected_count != null ? ` to ${response.affected_count} affected people` : ''}. Your evidence remains attached.
            </p>
          </div>
        </div>
      )}

      <div className="p-5">
        {response.missing_info_questions.length > 0 ? (
          <div>
            <div className="mb-4">
              <h4 className="text-sm font-semibold">Help refine the work order</h4>
              <p className="mt-1 text-xs leading-5 text-stone">Choose a quick answer or add detail. Answers are sent directly to this ticket.</p>
            </div>
            <div className="space-y-3">
              {response.missing_info_questions.map((question) => (
                <div key={question} className="rounded-xl border border-stitch bg-silk/60 p-4">
                  <p className="text-sm font-medium leading-6">{question}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {['Yes', 'No', 'Not sure'].map((answer) => (
                      <button
                        type="button"
                        key={answer}
                        disabled={submitting}
                        onClick={() => setAnswers((current) => ({ ...current, [question]: answer }))}
                        className={`rounded-full border px-3 py-1.5 text-xs transition ${answers[question] === answer ? 'border-ink bg-ink text-white' : 'border-stitch bg-white text-stone hover:text-ink'}`}
                      >
                        {answer}
                      </button>
                    ))}
                  </div>
                  <input
                    className="field mt-3 bg-white py-2.5 text-xs"
                    value={answers[question] || ''}
                    disabled={submitting}
                    placeholder="Add a specific answer (optional)"
                    aria-label={`Answer: ${question}`}
                    onChange={(event) => setAnswers((current) => ({ ...current, [question]: event.target.value }))}
                  />
                </div>
              ))}
            </div>
            <AnimatePresence>
              {error && <motion.p role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 text-xs text-red-700">{error}</motion.p>}
            </AnimatePresence>
            <button type="button" className="btn-primary mt-4" disabled={submitting} onClick={submitAnswers}>
              {submitting ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}
              {submitting ? 'Updating ticket…' : 'Send answers'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            <CheckCircle2 size={18} /> No further details are needed right now.
          </div>
        )}
        <div className="mt-5 flex items-center gap-2 border-t border-stitch pt-4 text-xs text-stone">
          <Check size={14} className="text-emerald-700" /> Track updates and community comments in the campus feed.
          <ArrowUpRight size={13} className="ml-auto" />
        </div>
      </div>
    </motion.section>
  );
}
