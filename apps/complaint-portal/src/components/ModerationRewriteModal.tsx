import { LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { Modal } from './Modal';

interface ModerationRewriteModalProps {
  original: string;
  suggestedRewrite: string;
  message?: string;
  submitting?: boolean;
  error?: string;
  onAccept: () => void;
  onClose: () => void;
}

export function ModerationRewriteModal({
  original,
  suggestedRewrite,
  message,
  submitting = false,
  error,
  onAccept,
  onClose,
}: ModerationRewriteModalProps) {
  return (
    <Modal
      title="Let’s keep the report constructive"
      description="The issue is important. A small language change will let it reach the campus response team."
      onClose={onClose}
    >
      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
        <ShieldCheck size={18} className="mt-1 shrink-0" />
        <p>{message || 'Frustrated or hostile phrasing was paused before publication. No public report has been created yet.'}</p>
      </div>
      <div className="mt-5">
        <p className="field-label">Your original wording</p>
        <p className="rounded-xl border border-stitch bg-silk p-4 text-sm leading-6 text-stone">{original}</p>
      </div>
      <div className="mt-5">
        <p className="field-label flex items-center gap-2"><Sparkles size={13} /> Respectful, fact-preserving rewrite</p>
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium leading-6 text-emerald-950">{suggestedRewrite}</p>
      </div>
      {error && <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>Edit my report</button>
        <button type="button" className="btn-primary" onClick={onAccept} disabled={submitting || !suggestedRewrite}>
          {submitting && <LoaderCircle size={16} className="animate-spin" />}
          {submitting ? 'Submitting rewrite…' : 'Use rewrite & submit'}
        </button>
      </div>
    </Modal>
  );
}
