import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Check, FileText, LoaderCircle, LockKeyhole, MapPin, RotateCcw, Send, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import type { AssetTarget, ComplaintApprovedResponse, ModerationRejectedResponse } from '../api/client';
import { AiFirstResponseCard } from '../components/AiFirstResponseCard';
import { AnonymousSwitch } from '../components/AnonymousSwitch';
import { CampusSpacePicker } from '../components/CampusSpacePicker';
import { ModerationRewriteModal } from '../components/ModerationRewriteModal';
import { PhotoUploader } from '../components/PhotoUploader';

export function NewComplaintPage() {
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [spaceCode, setSpaceCode] = useState('C4-03');
  const [selectedAssets, setSelectedAssets] = useState<AssetTarget[]>([]);
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUploadId, setPhotoUploadId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [rewriteError, setRewriteError] = useState('');
  const [moderation, setModeration] = useState<ModerationRejectedResponse | null>(null);
  const [originalText, setOriginalText] = useState('');
  const [held, setHeld] = useState<ModerationRejectedResponse | null>(null);
  const [approved, setApproved] = useState<ComplaintApprovedResponse | null>(null);
  const responseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (approved) responseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [approved]);

  const submitReport = async (text: string) => {
    const cleanText = text.trim();
    if (!spaceCode) {
      setError('Choose the campus space where the issue is occurring.');
      return;
    }
    if (cleanText.length < 12) {
      setError('Describe the issue in at least 12 characters so the response team can act on it.');
      return;
    }

    setSubmitting(true);
    setError('');
    setRewriteError('');
    setHeld(null);
    try {
      let uploadId = photoUploadId;
      if (photo && !uploadId) {
        const upload = await api.uploadPhoto(photo);
        uploadId = upload.id;
        setPhotoUploadId(uploadId);
      }
      const result = await api.createComplaint({
        space_code: spaceCode,
        description: cleanText,
        is_anonymous: isAnonymous,
        target_assets: selectedAssets,
        photo_upload_id: uploadId,
        client_timestamp: new Date().toISOString(),
      });

      if (result.moderation_status === 'APPROVED') {
        setDescription(cleanText);
        setApproved(result);
        setModeration(null);
      } else if (result.moderation_status === 'NEEDS_REWRITE') {
        setOriginalText(cleanText);
        setModeration(result);
      } else {
        setHeld(result);
        setModeration(null);
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Unable to submit the complaint.';
      if (moderation) setRewriteError(message);
      else setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (approved) {
      responseRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    void submitReport(description);
  };

  const resetStudio = () => {
    setApproved(null);
    setDescription('');
    setPhoto(null);
    setPhotoUploadId(undefined);
    setSelectedAssets([]);
    setHeld(null);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <motion.header initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <p className="eyebrow">New complaint & request studio</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Tell us what needs attention.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-stone">A precise report helps NOSIH identify the asset, assess urgency, and start the right response.</p>
      </motion.header>

      <div className="mb-7 grid grid-cols-4 gap-2" aria-label="Complaint submission stages">
        {['Privacy', 'Location', 'Details', 'AI response'].map((label, index) => (
          <div key={label} className="flex items-center gap-2">
            <span className={`mono flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] ${approved && index === 3 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-stitch bg-white text-stone'}`}>
              {approved && index === 3 ? <Check size={12} /> : index + 1}
            </span>
            <span className="hidden text-[11px] font-medium text-stone sm:block">{label}</span>
            {index < 3 && <span className="ml-auto hidden h-px flex-1 bg-stitch md:block" />}
          </div>
        ))}
      </div>

      {approved && (
        <div ref={responseRef} className="mb-8 scroll-mt-28">
          <AiFirstResponseCard
            complaint={approved.complaint}
            response={approved.first_response}
            onUpdated={(updated) => setApproved({ moderation_status: 'APPROVED', complaint: updated.complaint, first_response: updated.first_response })}
          />
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button type="button" className="btn-secondary" onClick={resetStudio}><RotateCcw size={16} /> Report another issue</button>
            <Link to="/feed" className="btn-primary">View campus feed <ArrowRight size={16} /></Link>
          </div>
        </div>
      )}

      <AnimatePresence>
        {held && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mb-6 flex items-start gap-4 rounded-2xl border border-red-200 bg-red-50 p-5 text-red-950"
          >
            <ShieldAlert size={22} className="mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">This submission cannot enter the campus portal</h2>
              <p className="mt-2 text-sm leading-6 text-red-800">{held.message || 'Harmful, threatening, defamatory, or abusive content is blocked by the campus moderation policy. The report was not published and did not change the digital twin.'}</p>
              <p className="mt-2 text-xs leading-5 text-red-700">Revise the report to focus only on a verifiable facility or safety issue.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <form onSubmit={handleSubmit} className={`cloth-card overflow-hidden ${approved ? 'opacity-70' : ''}`}>
        <fieldset disabled={submitting || Boolean(approved)}>
          <section className="border-b border-stitch p-5 sm:p-7">
            <div className="mb-5 flex items-start gap-3">
              <span className="mono mt-0.5 text-xs text-stone">01</span>
              <div>
                <h2 className="text-base font-semibold tracking-[-0.02em]">Choose your identity privacy</h2>
                <p className="mt-1 text-xs leading-5 text-stone">Both options reach the same response team. Anonymous identities are never added to the public report.</p>
              </div>
            </div>
            <AnonymousSwitch value={isAnonymous} onChange={setIsAnonymous} disabled={submitting || Boolean(approved)} />
            <div className="mt-4 flex items-start gap-2 text-[11px] leading-5 text-stone">
              <LockKeyhole size={14} className="mt-0.5 shrink-0" />
              Anonymous reporting encrypts your identity in the NOSIH vault. Named reporting displays your verified campus attribution.
            </div>
          </section>

          <section className="border-b border-stitch p-5 sm:p-7">
            <div className="mb-5 flex items-start gap-3">
              <span className="mono mt-0.5 text-xs text-stone">02</span>
              <div>
                <h2 className="text-base font-semibold tracking-[-0.02em]">Locate the issue</h2>
                <p className="mt-1 text-xs leading-5 text-stone">Select a campus space and, if known, the exact faulty equipment.</p>
              </div>
              <MapPin size={18} className="ml-auto text-stone" />
            </div>
            <CampusSpacePicker
              value={spaceCode}
              onChange={setSpaceCode}
              selectedAssets={selectedAssets}
              onAssetsChange={setSelectedAssets}
              disabled={submitting || Boolean(approved)}
            />
          </section>

          <section className="p-5 sm:p-7">
            <div className="mb-5 flex items-start gap-3">
              <span className="mono mt-0.5 text-xs text-stone">03</span>
              <div>
                <h2 className="text-base font-semibold tracking-[-0.02em]">Describe the problem</h2>
                <p className="mt-1 text-xs leading-5 text-stone">Include what happened, when it started, and any safety signs such as smoke or sparking.</p>
              </div>
              <FileText size={18} className="ml-auto text-stone" />
            </div>
            <label htmlFor="complaint-description" className="field-label">Problem description</label>
            <textarea
              id="complaint-description"
              className="field min-h-36 resize-y leading-6"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setError('');
                setHeld(null);
              }}
              placeholder="For example: Ceiling fans 2 and 3 stopped working during P2. The room is getting warm and about 55 students are in class."
              maxLength={4000}
              required
            />
            <div className="mt-2 flex justify-between text-[11px] text-stone">
              <span>Natural language is welcome. NOSIH will extract the details.</span>
              <span className="mono">{description.length}/4000</span>
            </div>

            <div className="mt-6">
              <label className="field-label">Photo evidence <span className="font-normal normal-case tracking-normal">(optional)</span></label>
              <PhotoUploader file={photo} onChange={(file) => { setPhoto(file); setPhotoUploadId(undefined); }} disabled={submitting || Boolean(approved)} />
            </div>
          </section>
        </fieldset>

        {!approved && (
          <div className="border-t border-stitch bg-silk/40 p-5 sm:px-7">
            <AnimatePresence>
              {error && (
                <motion.p role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  {error}
                </motion.p>
              )}
            </AnimatePresence>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <p className="flex flex-1 items-start gap-2 text-[11px] leading-5 text-stone">
                <ShieldCheck size={14} className="mt-0.5 shrink-0" />
                Every report is screened before publication. Valid safety issues are prioritized immediately.
              </p>
              <button type="submit" className="btn-primary shrink-0" disabled={submitting || !spaceCode || !description.trim()}>
                {submitting ? <LoaderCircle size={17} className="animate-spin" /> : <Send size={16} />}
                {submitting ? 'Verifying & submitting…' : 'Submit complaint'}
              </button>
            </div>
          </div>
        )}
      </form>

      <AnimatePresence>
        {moderation?.moderation_status === 'NEEDS_REWRITE' && (
          <ModerationRewriteModal
            original={originalText}
            suggestedRewrite={moderation.suggested_polite_rewrite || ''}
            message={moderation.message}
            submitting={submitting}
            error={rewriteError}
            onClose={() => {
              if (!submitting) setModeration(null);
            }}
            onAccept={() => void submitReport(moderation.suggested_polite_rewrite || '')}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
