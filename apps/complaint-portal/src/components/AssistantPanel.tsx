import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, MessagesSquare, Send, Sparkles, X } from 'lucide-react';
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

const SUGGESTIONS = [
  'Is my room usable right now?',
  'What faults are open on campus?',
  'How long will my complaint take?',
  'Which staff are on shift nearby?',
];

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function AssistantPanel() {
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
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

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy, open]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || busy) return;

      setError(null);
      const history = [...messages, { id: newId(), role: 'user' as ChatRole, content: body }];
      setMessages(history);
      setDraft('');
      setBusy(true);

      try {
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
            : 'The assistant could not be reached. Your complaint data is safe — try again in a moment.',
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, conversationId, focusSpace, messages],
  );

  const reset = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setError(null);
    setDraft('');
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
                Answers from the live digital twin · {spaceLabel}
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

          <div ref={scrollRef} className="thin-scrollbar flex-1 space-y-3 overflow-y-auto bg-cotton px-4 py-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed text-stone">
                  I read the live campus twin before answering, so room states, tickets, work orders and
                  SLA clocks always match what dispatch sees.
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => void send(suggestion)}
                      className="rounded-full border border-stitch bg-white px-3 py-1.5 text-[11px] font-medium text-ink transition hover:border-stone/40 hover:bg-silk"
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

            {busy && (
              <div className="mr-4 flex items-center gap-2 rounded-2xl border border-stitch bg-white px-3.5 py-3 text-[12px] text-stone shadow-cloth">
                <Sparkles size={15} strokeWidth={1.75} className="animate-pulse" />
                Reading the live twin…
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
              void send(draft);
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask about a room, ticket or SLA…"
              className="field flex-1 py-2.5 text-[13px]"
              aria-label="Message the campus assistant"
              maxLength={600}
            />
            <button
              type="submit"
              disabled={busy || draft.trim().length === 0}
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
