import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, ClipboardList, MapPin, MessagesSquare, Send, Sparkles, X } from 'lucide-react';
import { rpc } from '@nosih/supabase-client';
import { useAuthStore } from '../store/useAuthStore';
import { cx } from '../lib/format';

type ChatRole = 'user' | 'assistant';

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  cited?: string[];
  engine?: string;
};

type ChatReply = {
  success?: boolean;
  reply?: string;
  cited?: string[];
  engine?: string;
  model?: string;
  conversation_id?: string;
  error?: string;
};

type IntakeReply = {
  success?: boolean;
  error?: string;
  mode?: 'DRAFT' | 'CREATED';
  space_code?: string | null;
  space_type?: string | null;
  category?: string;
  urgency?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary?: string;
  questions?: string[];
  suggestions?: Array<{ space_code: string; reason: string }>;
  ticket_number?: string | null;
  work_order_number?: string | null;
  merged_into?: string | null;
  moderation_status?: string;
};

const SUGGESTIONS = [
  'Is my room usable right now?',
  'What faults are open on campus?',
  'What is the status of my complaint?',
  'Which staff are on shift right now?',
];

const REPORT_EXAMPLES = [
  'The ceiling fan in B2-04 is sparking during the lecture',
  'No water in the washroom near C4-01 since morning',
  'The projector in A1-03 will not switch on',
];

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function intakeError(error?: string) {
  switch (error) {
    case 'SIGN_IN_REQUIRED':
      return 'Sign in to report a fault.';
    case 'SPACE_REQUIRED':
      return 'Choose the room or lab where the fault is.';
    case 'NO_MESSAGE':
      return 'Describe what is wrong first.';
    default:
      return error ? error.replaceAll('_', ' ').toLowerCase() : 'The report could not be filed.';
  }
}

export function AssistantPanel() {
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'ask' | 'report'>('ask');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<IntakeReply | null>(null);
  const [draftSource, setDraftSource] = useState('');
  const [reportSpace, setReportSpace] = useState('');
  const [created, setCreated] = useState<IntakeReply | null>(null);
  const [draftText, setDraftText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const focusSpace = user?.home_room_code ?? null;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const spaceLabel = useMemo(
    () => (focusSpace ? focusSpace : 'whole campus'),
    [focusSpace],
  );

  const suggestions = useMemo(
    () => [
      focusSpace ? 'Is my room usable right now?' : 'Which rooms are unusable right now?',
      ...SUGGESTIONS.slice(1),
    ],
    [focusSpace],
  );

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, draft, created, busy, open]);

  const switchMode = useCallback((next: 'ask' | 'report') => {
    setMode(next);
    setMessages([]);
    setDraft(null);
    setCreated(null);
    setDraftSource('');
    setError(null);
    setDraftText('');
  }, []);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || busy) return;

      setError(null);
      const history = [...messages, { id: newId(), role: 'user' as ChatRole, content: body }];
      setMessages(history);
      setDraftText('');
      setBusy(true);

      try {
        if (mode === 'report') {
          const payload = (await rpc.chatIntake(
            history.map((message) => ({ role: message.role, content: message.content })),
            'COMPLAINT',
            null,
            false,
          )) as IntakeReply;
          if (!payload?.success) throw new Error(payload?.error ?? 'INTAKE_UNAVAILABLE');
          setDraft(payload);
          setDraftSource(body);
          setReportSpace(payload.space_code ?? focusSpace ?? '');
          setCreated(null);
          return;
        }

        const payload = (await rpc.aiChat(
          history.map((message) => ({ role: message.role, content: message.content })),
          'COMPLAINT',
          focusSpace,
          conversationId,
        )) as ChatReply;

        if (!payload?.success || !payload.reply) {
          throw new Error(String(payload?.error ?? 'ASSISTANT_UNAVAILABLE'));
        }

        setConversationId(payload.conversation_id ?? conversationId);
        setMessages((previous) => [
          ...previous,
          {
            id: newId(),
            role: 'assistant',
            content: payload.reply as string,
            cited: Array.isArray(payload.cited) ? payload.cited : [],
            engine: payload.engine,
          },
        ]);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'ASSISTANT_UNAVAILABLE';
        setError(
          message === 'SIGN_IN_REQUIRED'
            ? 'Sign in to talk to the campus assistant.'
            : mode === 'report'
              ? intakeError(message)
              : 'The assistant could not be reached. Your complaint data is safe — try again in a moment.',
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, conversationId, focusSpace, messages, mode],
  );

  const confirmDraft = useCallback(async () => {
    if (!draftSource || !reportSpace.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = (await rpc.chatIntake(
        [{ role: 'user', content: draftSource }],
        'COMPLAINT',
        reportSpace.trim(),
        true,
      )) as IntakeReply;
      if (!payload?.success) {
        setError(intakeError(payload?.error));
        return;
      }
      setCreated(payload);
      setDraft(null);
      setMessages([]);
      setDraftSource('');
    } catch (cause) {
      setError(cause instanceof Error ? intakeError(cause.message) : 'The report could not be filed.');
    } finally {
      setBusy(false);
    }
  }, [busy, draftSource, reportSpace]);

  const reset = useCallback(() => {
    setMessages([]);
    setDraft(null);
    setCreated(null);
    setDraftSource('');
    setReportSpace('');
    setConversationId(null);
    setError(null);
    setDraftText('');
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? 'Close campus assistant' : 'Open campus assistant'}
        aria-expanded={open}
        className={cx(
          'fixed bottom-5 right-5 z-50 inline-flex h-14 items-center gap-2 rounded-2xl border border-stitch px-4 shadow-cloth transition',
          open ? 'bg-white text-ink' : 'bg-ink text-white hover:bg-stone',
        )}
      >
        {open ? <X size={19} strokeWidth={1.75} /> : <MessagesSquare size={19} strokeWidth={1.75} />}
        <span className="text-sm font-semibold tracking-tight">{open ? 'Close' : 'Ask NOSIH'}</span>
      </button>

      {open && (
        <section
          className="cloth-card fixed bottom-24 right-5 z-50 flex h-[min(620px,calc(100vh-9rem))] w-[min(400px,calc(100vw-2.5rem))] flex-col overflow-hidden"
          aria-label="NOSIH campus assistant"
        >
          <header className="flex items-start gap-3 border-b border-stitch bg-silk px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-stitch bg-white">
              <Bot size={18} strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold tracking-tight text-ink">Campus assistant</p>
              <p className="mt-0.5 truncate text-[11px] text-stone">
                {mode === 'report' ? 'Fault intake · you confirm before anything is filed' : `Answers from the live digital twin · ${spaceLabel}`}
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-stitch bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone transition hover:text-ink"
            >
              New
            </button>
          </header>

          <div className="flex gap-1 border-b border-stitch bg-white px-3 py-2">
            {(['ask', 'report'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => switchMode(item)}
                className={cx(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition',
                  mode === item ? 'bg-ink text-white' : 'text-stone hover:bg-cotton hover:text-ink',
                )}
              >
                {item === 'ask' ? <Sparkles size={13} strokeWidth={1.75} /> : <ClipboardList size={13} strokeWidth={1.75} />}
                {item === 'ask' ? 'Ask' : 'Report a fault'}
              </button>
            ))}
          </div>

          <div ref={scrollRef} className="thin-scrollbar flex-1 space-y-3 overflow-y-auto bg-cotton px-4 py-4">
            {messages.length === 0 && !draft && !created && (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed text-stone">
                  {mode === 'report'
                    ? 'Describe the fault in your own words. I will extract the room, category and urgency, then you confirm before a ticket is filed.'
                    : 'I read the live campus twin before answering, so room states, tickets, work orders and SLA clocks always match what dispatch sees.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(mode === 'report' ? REPORT_EXAMPLES : suggestions).map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => void send(suggestion)}
                      className="rounded-full border border-stitch bg-white px-3 py-1.5 text-left text-[11px] font-medium text-ink transition hover:border-stone/40 hover:bg-silk"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <article
                key={message.id}
                className={cx(
                  'rounded-2xl border px-3.5 py-2.5 text-[13px] leading-relaxed',
                  message.role === 'user'
                    ? 'ml-6 border-ink/15 bg-ink text-white'
                    : 'mr-4 border-stitch bg-white text-ink shadow-cloth',
                )}
              >
                <p className="whitespace-pre-wrap">{message.content}</p>
                {message.role === 'assistant' && (message.cited?.length ?? 0) > 0 && (
                  <p className="mono mt-2 flex flex-wrap gap-1.5 border-t border-stitch pt-2 text-[10px] text-stone">
                    {message.cited?.map((code) => (
                      <span key={code} className="rounded-md bg-silk px-1.5 py-0.5">
                        {code}
                      </span>
                    ))}
                  </p>
                )}
              </article>
            ))}

            {draft && (
              <article className="mr-2 rounded-2xl border border-stitch bg-white p-3 shadow-cloth">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone">
                    <ClipboardList size={13} strokeWidth={1.75} /> Draft complaint
                  </p>
                  <span className="mono rounded-md bg-silk px-1.5 py-0.5 text-[9px] text-stone">{draft.category ?? 'UNCATEGORISED'}</span>
                </div>

                <label className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.12em] text-stone">
                  Room or lab
                  <span className="relative mt-1 block">
                    <MapPin size={13} strokeWidth={1.75} className="pointer-events-none absolute left-2.5 top-2.5 text-stone" />
                    <input
                      value={reportSpace}
                      onChange={(event) => setReportSpace(event.target.value.toUpperCase())}
                      placeholder="B2-04"
                      maxLength={16}
                      className="mono h-9 w-full rounded-lg border border-stitch bg-white pl-8 pr-2 text-xs font-normal uppercase tracking-normal text-ink outline-none focus:border-stone-400"
                    />
                  </span>
                </label>

                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider">
                  <span className="rounded-md border border-stitch bg-silk px-1.5 py-0.5 text-stone">{draft.urgency ?? 'MEDIUM'}</span>
                  {draft.space_type && <span className="rounded-md border border-stitch bg-silk px-1.5 py-0.5 text-stone">{draft.space_type}</span>}
                </div>

                <p className="mt-3 text-[12px] leading-relaxed text-ink">{draft.summary}</p>

                {draft.questions && draft.questions.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-stitch pt-2 text-[11px] leading-relaxed text-stone">
                    {draft.questions.map((question) => (
                      <li key={question}>· {question}</li>
                    ))}
                  </ul>
                )}

                {draft.suggestions && draft.suggestions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {draft.suggestions.map((suggestion) => (
                      <button
                        key={suggestion.space_code}
                        type="button"
                        onClick={() => setReportSpace(suggestion.space_code)}
                        className="mono rounded-md border border-stitch bg-silk px-2 py-1 text-[10px] transition hover:border-stone-400"
                      >
                        Use {suggestion.space_code}
                      </button>
                    ))}
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2 border-t border-stitch pt-3">
                  <button
                    type="button"
                    disabled={busy || !reportSpace.trim()}
                    onClick={() => void confirmDraft()}
                    className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-ink px-3 text-[11px] font-semibold text-white transition hover:bg-stone disabled:opacity-40"
                  >
                    {busy ? 'Filing…' : 'Confirm & file complaint'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraft(null)}
                    className="rounded-lg border border-stitch bg-white px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone transition hover:text-ink"
                  >
                    Discard
                  </button>
                </div>
              </article>
            )}

            {created && (
              <article className="mr-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-950">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <CheckCircle2 size={15} strokeWidth={1.75} /> Complaint filed
                </p>
                <p className="mono mt-2 text-sm font-semibold">{created.ticket_number ?? 'Ticket created'}</p>
                {created.work_order_number && (
                  <p className="mono mt-1 text-[10px] text-emerald-800">Work order {created.work_order_number}</p>
                )}
                {created.merged_into && (
                  <p className="mt-2 rounded-md border border-emerald-200 bg-white/60 p-2 text-[11px]">
                    This matched an existing report and was merged into {created.merged_into}.
                  </p>
                )}
                {created.moderation_status && created.moderation_status !== 'APPROVED' && (
                  <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
                    Held for moderation: {created.moderation_status.replaceAll('_', ' ').toLowerCase()}.
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-emerald-900">
                  It is now visible in the campus feed, with the room bound to the ticket.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setCreated(null);
                    setMessages([]);
                    setReportSpace('');
                  }}
                  className="mt-2 rounded-lg border border-emerald-300 bg-white px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-900"
                >
                  Report another fault
                </button>
              </article>
            )}

            {busy && (
              <div className="mr-4 flex items-center gap-2 rounded-2xl border border-stitch bg-white px-3.5 py-3 text-[12px] text-stone shadow-cloth">
                <Sparkles size={15} strokeWidth={1.75} className="animate-pulse" />
                {mode === 'report' ? 'Reading the fault and finding the room…' : 'Reading the live twin…'}
              </div>
            )}

            {error && (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                {error}
              </p>
            )}
          </div>

          <form
            className="flex items-center gap-2 border-t border-stitch bg-silk px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draftText);
            }}
          >
            <input
              ref={inputRef}
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              placeholder={mode === 'report' ? 'Describe the fault, e.g. fan sparking in B2-04…' : 'Ask about a room, ticket or SLA…'}
              className="field flex-1 py-2.5 text-[13px]"
              aria-label="Message the campus assistant"
              maxLength={600}
            />
            <button
              type="submit"
              disabled={busy || draftText.trim().length === 0}
              className="icon-button h-11 w-11 shrink-0 bg-ink text-white hover:bg-stone disabled:opacity-40"
              aria-label="Send message"
            >
              <Send size={17} strokeWidth={1.75} />
            </button>
          </form>
        </section>
      )}
    </>
  );
}
