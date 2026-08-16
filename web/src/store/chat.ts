import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface ChatSource {
  type: string;
  title: string;
  url?: string;
  // EP-59: Palace provenance fields (optional — additive, existing sources unchanged)
  wing?: string;
  room?: string;
  drawerId?: string;
}

/**
 * Phase 78a-05 — chip-selected conversation mode. Possible chip values are
 * 'auto' | 'work' | 'life'. The chip 'auto' tells the server to detect per
 * turn; 'work'/'life' force a manual override. New conversations default to
 * 'auto' (CHAT-06).
 */
export type ChatMode = 'auto' | 'work' | 'life';

/**
 * Phase 78a-05 — server-detected mode on the response. 'work' | 'life' are
 * concrete; 'ambiguous' is the AMBIGUOUS short-circuit. Stored on the
 * assistant message so ConversationHeader / PersonaFooter can render
 * "Auto → Work" subtitles reactively.
 */
export type DetectedMode = 'work' | 'life' | 'ambiguous';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
  suggestedFollowUps?: string[];
  ts: number;
  // Phase 61: proactive notification flag (set by SSE-injected messages)
  isProactive?: boolean;
  /** Chat could not answer — user should run sync (see suggestedFollowUps) */
  needsSync?: boolean;
  // Phase 78a-05 — server response telemetry. Present on assistant messages
  // produced by /api/chat (post-78a-04). Absent on legacy messages and
  // proactive SSE-injected ones.
  detectedMode?: DetectedMode;
  modeSource?: 'auto' | 'manual';
  modeSignals?: string[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  /**
   * Phase 78a-05 — chip-selected mode for this conversation. Always present
   * (D-78a-04: required, not optional). Defaults to 'auto' on session
   * creation. Persists via the existing `persist` middleware along with
   * the rest of the session.
   */
  mode: ChatMode;
}

const MAX_SESSIONS = 20;

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

function titleFromMessage(msg: string): string {
  return msg.length > 48 ? msg.slice(0, 48) + '…' : msg;
}

interface ChatStore {
  sessions: ChatSession[];
  activeSessionId: string;
  isLoading: boolean;

  // Active session helpers (derived from sessions + activeSessionId)
  activeSession: () => ChatSession | undefined;
  messages: () => ChatMessage[];

  // Session management
  newSession: (initialTitle?: string) => string; // returns new session id
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;

  // Message actions (operate on active session)
  addUserMessage: (content: string) => string;
  addAssistantMessage: (
    id: string,
    reply: string,
    sources?: ChatSource[],
    suggestedFollowUps?: string[],
    isProactive?: boolean,
    needsSync?: boolean,
    modeMeta?: { detectedMode?: DetectedMode; modeSource?: 'auto' | 'manual'; modeSignals?: string[] },
  ) => void;
  setLoading: (v: boolean) => void;

  // Phase 78a-05 — chip writes mode through this action; new chip selection
  // takes effect on the next chat POST.
  setMode: (sessionId: string, mode: ChatMode) => void;

  // Legacy compat
  clearSession: () => void;
  sessionId: string;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => {
      const firstSessionId = newId();
      const firstSession: ChatSession = {
        id: firstSessionId,
        title: 'New conversation',
        messages: [],
        createdAt: Date.now(),
        mode: 'auto',
      };

      return {
        sessions: [firstSession],
        activeSessionId: firstSessionId,
        isLoading: false,
        sessionId: firstSessionId, // legacy compat for any code reading this

        activeSession: () => get().sessions.find(s => s.id === get().activeSessionId),

        messages: () => get().activeSession()?.messages ?? [],

        newSession: (initialTitle) => {
          const id = newId();
          const session: ChatSession = {
            id,
            title: initialTitle ?? 'New conversation',
            messages: [],
            createdAt: Date.now(),
            mode: 'auto',
          };
          set(s => {
            const sessions = [session, ...s.sessions].slice(0, MAX_SESSIONS);
            return { sessions, activeSessionId: id, sessionId: id };
          });
          return id;
        },

        switchSession: (id) => {
          set({ activeSessionId: id, sessionId: id });
        },

        deleteSession: (id) => {
          set(s => {
            const sessions = s.sessions.filter(s => s.id !== id);
            if (sessions.length === 0) {
              const newSess: ChatSession = { id: newId(), title: 'New conversation', messages: [], createdAt: Date.now(), mode: 'auto' };
              return { sessions: [newSess], activeSessionId: newSess.id, sessionId: newSess.id };
            }
            const activeSessionId = s.activeSessionId === id ? sessions[0].id : s.activeSessionId;
            return { sessions, activeSessionId, sessionId: activeSessionId };
          });
        },

        addUserMessage: (content) => {
          const id = newId();
          const msg: ChatMessage = { id, role: 'user', content, ts: Date.now() };
          set(s => ({
            sessions: s.sessions.map(sess =>
              sess.id === s.activeSessionId
                ? {
                    ...sess,
                    // Auto-title from first user message
                    title: sess.messages.length === 0 ? titleFromMessage(content) : sess.title,
                    messages: [...sess.messages, msg],
                  }
                : sess
            ),
          }));
          return id;
        },

        addAssistantMessage: (id, reply, sources, suggestedFollowUps, isProactive, needsSync, modeMeta) => {
          const msg: ChatMessage = {
            id,
            role: 'assistant',
            content: reply,
            sources,
            suggestedFollowUps,
            ts: Date.now(),
            isProactive,
            needsSync,
            detectedMode: modeMeta?.detectedMode,
            modeSource: modeMeta?.modeSource,
            modeSignals: modeMeta?.modeSignals,
          };
          set(s => ({
            sessions: s.sessions.map(sess =>
              sess.id === s.activeSessionId
                ? { ...sess, messages: [...sess.messages, msg] }
                : sess
            ),
          }));
        },

        setLoading: (v) => set({ isLoading: v }),

        // Phase 78a-05 — chip writes mode here. Immutable per-session update
        // matching the existing setter style.
        setMode: (sessionId, mode) => {
          set(s => ({
            sessions: s.sessions.map(sess =>
              sess.id === sessionId ? { ...sess, mode } : sess
            ),
          }));
        },

        // Legacy: clears active session messages (same as newSession but keeps id)
        clearSession: () => {
          const id = newId();
          const session: ChatSession = { id, title: 'New conversation', messages: [], createdAt: Date.now(), mode: 'auto' };
          set(s => ({
            sessions: [session, ...s.sessions].slice(0, MAX_SESSIONS),
            activeSessionId: id,
            sessionId: id,
          }));
        },
      };
    },
    {
      name: 'wi-chat-sessions',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ sessions: s.sessions, activeSessionId: s.activeSessionId }),
      // Phase 78a-05 — back-fill `mode: 'auto'` on sessions persisted before
      // the field existed. Without this, hydrated sessions render with
      // `mode: undefined` and ModeChips can't determine the active chip.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<{ sessions: ChatSession[]; activeSessionId: string }>;
        const sessions = (p.sessions ?? current.sessions).map(s => ({
          ...s,
          mode: (s as ChatSession).mode ?? 'auto' as ChatMode,
        }));
        return {
          ...current,
          ...p,
          sessions,
          sessionId: p.activeSessionId ?? current.activeSessionId,
        };
      },
    }
  )
);

/** Returns the last N turns of the active session for the API request */
export function getHistoryForApi(
  messages: ChatMessage[],
  maxTurns = 10
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .slice(-maxTurns)
    .map((m) => ({ role: m.role, content: m.content }));
}
