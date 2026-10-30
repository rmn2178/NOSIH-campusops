import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Send, Sparkles, X } from 'lucide-react';
import { rpc } from '@nosih/supabase-client';
import { usePortalStore } from '../../store/portalStore';
import { Badge, Button, cx } from '../ui';

type ChatRole = 'user' | 'assistant';

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  cited?: string[];
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

const SUGGESTIONS: Record<string, string[]> = {
  twin: ['Which spaces are unhealthy right now?', 'Which work orders are most urgent?'],
  dispatch: ['Which work orders need an assignee first?', 'Summarise the active incidents.'],
  sla: ['Which SLA clocks are closest to breach?', 'What is breaching in the next hour?'],
  inventory: ['Which parts are short for open work orders?', 'What purchase requests are waiting?'],
  moderation: ['What is held for moderation and why?', 'Which complaints were rewritten by AI?'],
  timetable: ['Are there timetable conflicts right now?'],
  audit: ['What did the AI change most recently?'],
  integrations: ['Which inbound channels are pending?'],
};

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function AssistantDock() {
  const { workspace, selectedSpaceCode } = usePortalStore();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const prompts = useMemo(() => {
    const base = SUGGESTIONS[workspace] ?? SUGGESTIONS.twin;
    if (!selectedSpaceCode) return base;
    return [
      `What is the state of ${selectedSpaceCode}?`,
      `Find a relocation room for ${selectedSpaceCode}`,
      ...base,
    ];
  }, [selectedSpaceCode, workspace]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 60);
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
      const history: ChatMessage[] = [...messages, { id: newId(), role: 'user', content: body }];
      setMessages(history);
      setDraft('');
      setBusy(true);

      try {
        const payload = (await rpc.aiChat(
          history.map((message) => ({ role: message.role, content: message.content })),
          'ADMIN',
          selectedSpaceCode,
          conversationId,
        )) as ChatReply;

        if (!payload?.success || !payload.reply) {
          throw new Error(String(payload?.error ?? 'ASSISTANT_UNAVAILABLE'));
        }

        setConversationId(payload.conversation_id ?? conversationId);
        setEngine(payload.engine ?? null);
        setMessages((previous) => [
          ...previous,
          {
            id: newId(),
            role: 'assistant',
            content: payload.reply as string,
            cited: Array.isArray(payload.cited) ? payload.cited : [],
          },
        ]);
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message === 'SIGN_IN_REQUIRED'
            ? 'Sign in again to use the operations assistant.'
            : 'The assistant could not be reached. Twin state is unaffected — retry in a moment.',
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, conversationId, messages, selectedSpaceCode],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? 'Close operations assistant' : 'Open operations assistant'}
        aria-expanded={open}
        className={cx(
          'fixed bottom-5 right-5 z-[110] inline-flex h-11 items-center gap-2 rounded-xl border px-3.5 text-xs font-medium shadow-float transition',
          open
            ? 'border-stitch bg-white text-obsidian'
            : 'border-obsidian bg-obsidian text-white hover:bg-[#26262a]',
        )}
      >
        {open ? <X className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        <span className="tracking-tight">{open ? 'Close assistant' : 'Twin assistant'}</span>
        {!open && selectedSpaceCode && <span className="mono rounded-md bg-white/15 px-1.5 py-0.5 text-[10px]">{selectedSpaceCode}</span>}
      </button>

      {open && (
        <section
          className="fixed bottom-20 right-5 z-[115] flex h-[min(600px,calc(100vh-8rem))] w-[min(420px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-stitch bg-white shadow-float"
          aria-label="NOSIH operations assistant"
        >
          <header className="flex items-start gap-3 border-b border-stitch bg-[#f7f6f1] px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-obsidian text-white">
              <Bot className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold tracking-tight">Twin assistant</p>
              <p className="mt-0.5 truncate text-[10px] uppercase tracking-[0.14em] text-stone">
                Grounded in live campus state{selectedSpaceCode ? ` · ${selectedSpaceCode}` : ''}
              </p>
            </div>
            {engine && <Badge tone={engine === 'grok' ? 'green' : 'amber'}>{engine === 'grok' ? 'AI' : 'Snapshot'}</Badge>}
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-[10px] uppercase tracking-[0.12em] text-stone"
              onClick={() => {
                setMessages([]);
                setConversationId(null);
                setError(null);
                setDraft('');
              }}
            >
              New
            </Button>
          </header>

          <div ref={scrollRef} className="scrollbar-thin flex-1 space-y-2.5 overflow-y-auto bg-white px-4 py-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-[11px] leading-relaxed text-stone">
                  Every answer is generated from the same twin snapshot the workspaces read: spaces,
                  assets, work orders, SLA clocks, incidents and staff on shift.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {prompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => void send(prompt)}
                      className="rounded-lg border border-stitch bg-[#f7f6f1] px-2.5 py-1.5 text-[11px] text-obsidian transition hover:border-stone/50 hover:bg-white"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <article
                key={message.id}
                className={cx(
                  'rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed',
                  message.role === 'user'
                    ? 'ml-8 border-obsidian/15 bg-obsidian text-white'
                    : 'mr-6 border-stitch bg-[#fbfaf7] text-obsidian',
                )}
              >
                <p className="whitespace-pre-wrap">{message.content}</p>
                {message.role === 'assistant' && (message.cited?.length ?? 0) > 0 && (
                  <p className="mono mt-2 flex flex-wrap gap-1 border-t border-stitch pt-2 text-[10px] text-stone">
                    {message.cited?.map((code) => (
                      <span key={code} className="rounded bg-silk px-1.5 py-0.5">{code}</span>
                    ))}
                  </p>
                )}
              </article>
            ))}

            {busy && (
              <div className="mr-6 flex items-center gap-2 rounded-xl border border-stitch bg-[#fbfaf7] px-3 py-2.5 text-[11px] text-stone">
                <Sparkles className="h-3.5 w-3.5 animate-pulse" />
                Reading the twin snapshot…
              </div>
            )}

            {error && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                {error}
              </p>
            )}
          </div>

          <form
            className="flex items-center gap-2 border-t border-stitch bg-[#f7f6f1] px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask about dispatch, SLA, staffing…"
              aria-label="Message the operations assistant"
              maxLength={600}
              className="w-full rounded-lg border border-stitch bg-white px-3 py-2 text-xs text-obsidian placeholder:text-stone/70 focus:border-stone/50 focus:outline-none"
            />
            <Button
              type="submit"
              size="icon"
              variant="primary"
              disabled={busy || draft.trim().length === 0}
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </section>
      )}
    </>
  );
}
