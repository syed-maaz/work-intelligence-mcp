import { useRef, useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { X, Send, Trash2, Sparkles, Plus } from 'lucide-react';
import { useUIStore } from '@/store/ui';
import { useChatStore, getHistoryForApi } from '@/store/chat';
import { api, type TicketDetail, type DecisionResult } from '@/lib/api';
import { wiSyncAll, wiSyncStatus } from '@/lib/wi-tools';
import { ChatMessage } from '@/components/shared/ChatMessage';
import { DecisionCard } from '@/components/brain/DecisionCard';
// Phase 78a-05 — mode-aware UI
import { ModeChips } from '@/components/chat/ModeChips';
import { ConversationHeader } from '@/components/chat/ConversationHeader';
import { PersonaFooter } from '@/components/chat/PersonaFooter';

const CHAT_MIN_WIDTH = 320;
const CHAT_MAX_WIDTH = 900;
const CHAT_DEFAULT_WIDTH = 320;
const SESSION_SIDEBAR_WIDTH = 176; // w-44

// Decision-shaped question detection: verb-led + ends with ?
const DECISION_RE = /^(what|which|should|where|how|who)\s/i;

function getSavedWidth(): number {
  const v = localStorage.getItem('wi-chat-width');
  const n = v ? parseInt(v, 10) : NaN;
  return isNaN(n) ? CHAT_DEFAULT_WIDTH : Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, n));
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
}

const STARTER_PROMPTS = [
  'What are my open action items?',
  'Summarise yesterday\'s Teams activity',
  'What\'s blocking the Saturn sprint?',
  'Any decisions made this week?',
];

// OP-7 / U-3: human-readable labels for brain-decide pipeline stages.
const STAGE_LABELS: Record<string, string> = {
  cache_lookup: 'Checking cache…',
  cache_hit: 'Found cached answer',
  budget_check: 'Checking budget…',
  thinking: 'Asking the brain…',
  persisting: 'Saving decision…',
  done: 'Done',
};

function TypingIndicator({ showResearchHint, brainStage }: { showResearchHint?: boolean; brainStage?: string | null }) {
  const stageLabel = brainStage ? STAGE_LABELS[brainStage] ?? brainStage : null;
  const accent = !!(stageLabel || showResearchHint);
  return (
    <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-2xl rounded-bl-sm w-fit" style={{ background: 'var(--bg-3)' }}>
      {stageLabel ? (
        <span className="text-xs mr-1" style={{ color: 'var(--accent)' }}>{stageLabel}</span>
      ) : showResearchHint ? (
        <span className="text-xs mr-1" style={{ color: 'var(--accent)' }}>Researching codebase</span>
      ) : null}
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background: accent ? 'var(--accent)' : 'var(--muted)',
            animation: `typing-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes typing-dot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

export function ChatPanel({ fullPage = false }: { fullPage?: boolean }) {
  const { toggleChat, pendingChatMessage, clearPendingChatMessage } = useUIStore();
  const {
    sessions, activeSessionId,
    isLoading,
    addUserMessage, addAssistantMessage, setLoading,
    newSession, switchSession, deleteSession,
  } = useChatStore();
  const messages = useChatStore(s => s.messages());
  const location = useLocation();

  const [input, setInput] = useState('');
  const [chatWidth, setChatWidth] = useState(getSavedWidth);
  const [researchHint, setResearchHint] = useState(false);
  // Maps assistant message ID → DecisionResult for decision-shaped responses
  const [decisionResults, setDecisionResults] = useState<Record<string, DecisionResult>>({});
  // OP-7 / U-3: current pipeline stage for decision-shaped questions ('thinking', 'persisting', ...)
  const [brainStage, setBrainStage] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastHandledRef = useRef<string | null>(null);
  const dragStartX = useRef<number | null>(null);
  const dragStartWidth = useRef<number>(CHAT_DEFAULT_WIDTH);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartX.current = e.clientX;
    dragStartWidth.current = getSavedWidth(); // read current persisted width, no stale closure

    function onMove(ev: MouseEvent) {
      if (dragStartX.current === null) return;
      const delta = dragStartX.current - ev.clientX; // left edge: move left = wider
      const next = Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, dragStartWidth.current + delta));
      setChatWidth(next);
      localStorage.setItem('wi-chat-width', String(next));
    }
    function onUp() {
      dragStartX.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    if (!isLoading) { setResearchHint(false); return; }
    const timer = setTimeout(() => setResearchHint(true), 3000);
    return () => clearTimeout(timer);
  }, [isLoading]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 112) + 'px';
  }, [input]);

  // Focus textarea when panel opens
  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, []);

  // Auto-submit pending message injected from outside (e.g. ticket action buttons).
  // lastHandledRef prevents double-fire when the panel mounts with an already-set value.
  useEffect(() => {
    if (pendingChatMessage && pendingChatMessage !== lastHandledRef.current) {
      lastHandledRef.current = pendingChatMessage;
      clearPendingChatMessage();
      submit(pendingChatMessage);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingChatMessage]);

  // Subscribe to proactive notifications via SSE — one connection per ChatPanel mount lifetime
  useEffect(() => {
    interface ProactiveEvent {
      id: number;
      agent: string;
      type: string;
      title: string;
      body: string;
      action_url?: string;
      created_at: string;
    }
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as ProactiveEvent;
        const id = `proactive-${event.id}`;
        const content = `${event.title}\n\n${event.body}`;
        addAssistantMessage(id, content, [], [], true);
      } catch {
        // malformed SSE data — ignore
      }
    };
    es.onerror = () => {
      // silent — browser auto-reconnects via retry: 3000 SSE header
      console.warn('[SSE] /api/events connection error — browser will reconnect');
    };
    return () => {
      es.close();
    };
  }, []); // empty deps — one connection per ChatPanel mount lifetime

  async function runSyncFlow(pendingQuestion?: string) {
    const replyId = Math.random().toString(36).slice(2, 16);
    setLoading(true);
    try {
      const start = await wiSyncAll();
      if (!start.ok) {
        addAssistantMessage(
          replyId,
          `**wi_sync** failed: ${start.error?.message ?? 'unknown error'}. Is the bridge running on :3132?`,
          [],
          ['Check sync status'],
        );
        return;
      }
      const startData = start.data as { status?: string; running?: boolean };
      if (startData.status === 'already_running' || startData.running) {
        addAssistantMessage(
          replyId,
          '**wi_sync**: sync already running. Checking progress…',
          [],
          ['Check sync status'],
        );
      } else {
        addAssistantMessage(
          replyId,
          '**wi_sync** started a full sync (Teams, calendar, …). Usually 2–5 minutes with browser profile open.',
          [],
          ['Check sync status'],
        );
      }
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const stRes = await wiSyncStatus();
        if (!stRes.ok) break;
        const st = stRes.data as {
          running?: boolean;
          completedTopics?: string[];
          completedAt?: string | null;
          error?: string | null;
        };
        if (!st.running) {
          const doneId = Math.random().toString(36).slice(2, 16);
          const ok = st.completedTopics?.filter((t) => !String(t).includes('skipped')).length;
          addAssistantMessage(
            doneId,
            st.error
              ? `**wi_sync** finished with an error: ${st.error}`
              : `**wi_sync** finished${ok ? ` (${ok} step(s) OK)` : ''}. Ask your question again.`,
            [],
            pendingQuestion ? [pendingQuestion] : ["Summarise yesterday's Teams activity"],
          );
          break;
        }
      }
    } catch (err) {
      addAssistantMessage(
        replyId,
        `Could not run **wi_sync**: ${err instanceof Error ? err.message : 'Unknown error'}. See **Setup** or use the wi-sync skill in Claude Code.`,
        [],
        [],
      );
    } finally {
      setLoading(false);
    }
  }

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    if (trimmed === 'Run sync now') {
      setInput('');
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      await runSyncFlow(lastUser?.content);
      return;
    }
    if (trimmed === 'Check sync status') {
      setInput('');
      setLoading(true);
      const replyId = Math.random().toString(36).slice(2, 16);
      try {
        const stRes = await wiSyncStatus();
        if (!stRes.ok) {
          addAssistantMessage(
            replyId,
            `**wi_sync** status failed: ${stRes.error?.message ?? 'error'}`,
            [],
            ['Run sync now'],
          );
        } else {
          const st = stRes.data as {
            running?: boolean;
            currentTopic?: string | null;
            completedAt?: string | null;
            error?: string | null;
          };
          addAssistantMessage(
            replyId,
            st.running
              ? `**wi_sync** in progress: ${st.currentTopic ?? 'working'}…`
              : `**wi_sync** idle. Last run: ${st.completedAt ?? 'never'}${st.error ? ` (error: ${st.error})` : ''}.`,
            [],
            st.running ? ['Check sync status'] : ['Run sync now'],
          );
        }
      } catch (err) {
        addAssistantMessage(replyId, `Status check failed: ${err instanceof Error ? err.message : 'error'}`, [], []);
      } finally {
        setLoading(false);
      }
      return;
    }

    setInput('');
    addUserMessage(trimmed);
    setLoading(true);
    const replyId = Math.random().toString(36).slice(2, 16);

    // Decision-shaped detection: verb-led pattern AND ends with ?
    const isDecisionQuestion = DECISION_RE.test(trimmed) && trimmed.endsWith('?');

    try {
      if (isDecisionQuestion) {
        // OP-7 / U-3: prefer the streaming SSE endpoint so the user sees
        // pipeline progress instead of 5–25 s of silence. Fall back to the
        // non-streaming POST if EventSource isn't available or the stream
        // fails before producing a result.
        setBrainStage('cache_lookup');
        let result: DecisionResult | null = null;
        try {
          const { promise } = api.streamBrainDecide(
            { question: trimmed },
            { onStage: (stage) => setBrainStage(stage) },
          );
          result = await promise;
        } catch (streamErr) {
          // Network blip / unsupported transport — drop back to the JSON POST.
          // The cached path is fast enough that the user won't notice.
          console.warn('[brain/decide/stream] fell back to POST:', streamErr);
          result = await api.postBrainDecide({ question: trimmed });
        } finally {
          setBrainStage(null);
        }
        addAssistantMessage(replyId, result.decision, [], []);
        setDecisionResults(prev => ({ ...prev, [replyId]: result! }));
      } else {
        // Pure-chat fallback: existing /api/chat path
        let injectedContext: string | undefined;
        const ticketKeys = [...trimmed.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)].map(m => m[1]).slice(0, 3);
        if (ticketKeys.length > 0) {
          const results = await Promise.allSettled(ticketKeys.map(k => api.getTicketDetail(k)));
          const summaries = results
            .filter((r): r is PromiseFulfilledResult<TicketDetail> => r.status === 'fulfilled')
            .map(r => r.value);
          if (summaries.length > 0) {
            injectedContext = summaries.map(t =>
              `${t.key}: ${t.title} [${t.status}]${t.assignee ? ` — assigned to ${t.assignee}` : ''}${t.description ? '\n' + t.description : ''}`
            ).join('\n\n');
          }
        }
        // Phase 78a-05 — pull the chip-selected mode + session id at call
        // time so we always send the freshest value (not a stale closure).
        const sess = useChatStore.getState().activeSession();
        const mode = sess?.mode ?? 'auto';
        const conversationId = sess?.id;
        const resp = await api.chat({
          message: trimmed,
          history: getHistoryForApi(messages),
          context: { page: location.pathname },
          ...(injectedContext ? { injectedContext } : {}),
          mode,
          ...(conversationId ? { conversationId } : {}),
        });
        addAssistantMessage(
          replyId,
          resp.reply,
          resp.sources,
          resp.suggestedFollowUps,
          false,
          resp.needsSync,
          // Phase 78a-05 — persist server response telemetry on the message
          // so ConversationHeader / PersonaFooter can react to detectedMode.
          {
            detectedMode: resp.detectedMode,
            modeSource: resp.modeSource,
            modeSignals: resp.modeSignals,
          },
        );
      }
    } catch (err) {
      addAssistantMessage(
        replyId,
        `Sorry, something went wrong: ${err instanceof Error ? err.message : 'Unknown error'}`,
        [], []
      );
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(input);
    }
  }

  const latestAssistantIndex = messages.reduce(
    (last, m, i) => (m.role === 'assistant' ? i : last), -1
  );

  const isEmpty = messages.length === 0;

  const panelWidth = fullPage ? '100%' : `${chatWidth + SESSION_SIDEBAR_WIDTH}px`;

  return (
    <aside
      className={`flex w-full shrink-0 h-full relative ${fullPage ? '' : 'md:w-auto border-l'}`}
      style={{ background: 'var(--bg)', borderColor: 'var(--border)', width: panelWidth }}
    >
      {/* Drag-to-resize handle — sidebar mode only */}
      {!fullPage && (
      <div
        className="absolute left-0 top-0 bottom-0 w-1 hidden md:block cursor-col-resize z-10 hover:bg-[var(--accent)] transition-colors"
        style={{ opacity: 0.4 }}
        onMouseDown={onDragStart}
        title="Drag to resize"
      />
      )}

      {/* Session sidebar — hidden on mobile */}
      <div
        className="hidden md:flex flex-col border-r shrink-0 h-full"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', width: `${SESSION_SIDEBAR_WIDTH}px` }}
      >
        {/* New session button */}
        <div className="px-2 py-2 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={() => newSession()}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--bg-3)]"
            style={{ color: 'var(--fg-2)' }}
          >
            <Plus size={11} />
            New chat
          </button>
        </div>
        {/* Session list */}
        <div className="flex-1 overflow-y-auto py-1">
          {sessions.map(sess => (
            <div
              key={sess.id}
              className="group relative flex items-start px-2 py-1.5 mx-1 rounded-lg cursor-pointer transition-colors hover:bg-[var(--bg-3)]"
              style={{
                background: sess.id === activeSessionId ? 'var(--bg-3)' : 'transparent',
              }}
              onClick={() => switchSession(sess.id)}
            >
              <div className="flex-1 min-w-0 pr-4">
                <p
                  className="text-[11px] font-medium truncate leading-tight"
                  style={{ color: sess.id === activeSessionId ? 'var(--fg)' : 'var(--fg-2)' }}
                >
                  {sess.title}
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  {relativeTime(sess.createdAt)}
                </p>
              </div>
              {sessions.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); deleteSession(sess.id); }}
                  className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded transition-opacity hover:bg-[var(--danger)] z-10"
                  style={{ color: 'var(--muted)' }}
                  title="Delete session"
                >
                  <X size={9} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main chat column */}
      <div className="flex flex-col shrink-0 h-full min-w-0 flex-1">
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b shrink-0"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-md flex items-center justify-center"
              style={{ background: 'var(--accent)' }}
            >
              <Sparkles size={12} className="text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold leading-none truncate max-w-[130px]" style={{ color: 'var(--fg)' }}>
                {useChatStore.getState().activeSession()?.title ?? 'Assistant'}
              </p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>Powered by Claude</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Phase 78a-05 — chip-selected mode (auto/work/life). */}
            <ModeChips />
            {messages.length > 0 && (
              <button
                onClick={() => newSession()}
                title="New conversation"
                className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--bg-3)]"
                style={{ color: 'var(--muted)' }}
              >
                <Trash2 size={13} />
              </button>
            )}
            {!fullPage && (
            <button
              onClick={toggleChat}
              title="Close"
              className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--bg-3)]"
              style={{ color: 'var(--muted)' }}
            >
              <X size={15} />
            </button>
            )}
          </div>
        </div>

        {/* Messages / Empty state */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Phase 78a-05 — conversation-level mode header (emoji + persona summary) */}
          <ConversationHeader />
          {isEmpty && !isLoading ? (
            <div className="flex flex-col gap-4 h-full">
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center py-8">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center mb-1"
                  style={{ background: 'var(--bg-3)' }}
                >
                  <Sparkles size={18} style={{ color: 'var(--accent)' }} />
                </div>
                <p className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
                  Ask about your work
                </p>
                <p className="text-xs max-w-[18rem]" style={{ color: 'var(--muted)' }}>
                  Search Jira, Teams, email and meetings — or ask for a summary of anything.
                </p>
              </div>
              {/* Starter prompts */}
              <div className="space-y-1.5">
                {STARTER_PROMPTS.map((q) => (
                  <button
                    key={q}
                    onClick={() => submit(q)}
                    className="w-full text-left text-xs px-3 py-2.5 rounded-xl border transition-colors hover:bg-[var(--bg-3)]"
                    style={{ borderColor: 'var(--border)', color: 'var(--fg)', background: 'var(--bg-2)' }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                // If this assistant message has a stored DecisionResult, render DecisionCard instead
                msg.role === 'assistant' && decisionResults[msg.id] ? (
                  <div key={msg.id} className="flex flex-col gap-1.5 items-start">
                    <DecisionCard decision={decisionResults[msg.id]} />
                  </div>
                ) : (
                  <ChatMessage
                    key={msg.id}
                    message={msg}
                    isLatest={i === latestAssistantIndex}
                    onFollowUp={submit}
                  />
                )
              ))}
              {isLoading && (
                <div className="flex items-start">
                  <TypingIndicator showResearchHint={researchHint} brainStage={brainStage} />
                </div>
              )}
            </>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div
          className="border-t p-3 shrink-0"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        >
          <div
            className="flex items-end gap-2 rounded-xl border px-3 py-2.5"
            style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question…"
              rows={1}
              className="flex-1 resize-none bg-transparent text-xs outline-none leading-relaxed"
              style={{ color: 'var(--fg)', maxHeight: '112px', fontFamily: 'inherit' }}
            />
            <button
              onClick={() => submit(input)}
              disabled={!input.trim() || isLoading}
              className="flex items-center justify-center w-7 h-7 rounded-lg shrink-0 transition-all disabled:opacity-30"
              style={{
                background: input.trim() ? 'var(--accent)' : 'var(--bg-3)',
                color: input.trim() ? '#fff' : 'var(--muted)',
              }}
            >
              <Send size={12} />
            </button>
          </div>
          <p className="text-[10px] mt-1.5 text-center" style={{ color: 'var(--muted)' }}>
            Enter to send · Shift+Enter for new line
          </p>
          {/* Phase 78a-05 — auto-dismissed mode-change announcement (5s) */}
          <PersonaFooter />
        </div>
      </div>
    </aside>
  );
}
