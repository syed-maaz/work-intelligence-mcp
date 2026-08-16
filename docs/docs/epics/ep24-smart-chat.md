---
title: "EP-24: Smart Chat Sidebar"
sidebar_label: "EP-24: Smart Chat"
---

# EP-24: Smart Chat Sidebar

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | AI / Full-Stack Engineer |
| **Depends On** | — |
| **Blocks** | — |
| **File Scope** | `src/services/analyzer.ts` (edit), `web-server.js` (edit), `web/src/store/chat.ts` (new), `web/src/store/ui.ts` (edit), `web/src/lib/api.ts` (edit), `web/src/components/shell/ChatPanel.tsx` (new), `web/src/components/shared/ChatMessage.tsx` (new), `web/src/components/shell/AppShell.tsx` (edit), `web/src/components/shell/Sidebar.tsx` (edit) |

## Goal

A persistent AI chat panel in the right sidebar of the app. The user talks to it in natural language about their work, asks questions about Jira issues or team updates, and gets intelligent answers sourced from the SQLite DB. Multi-turn, context-aware, always visible. The user said: "I want a smart chat system... I should talk to system in natural language about the day it should look into database and give intelligent answers or if didn't find ask question and try to retrieve it."

## Design Decision: Persistent Sidebar Panel

The user explicitly chose **persistent sidebar panel** over floating button or dedicated page. The chat is always visible alongside the main content — like a co-pilot. It knows which page the user is on and auto-injects that as context.

## Architecture

```
User types message
       ↓
POST /api/chat  { message, history (last 10 turns), context: { page, projectKey? } }
       ↓
web-server.js handler:
  1. Extract keywords (reuse extractKeywords() from topic-expert.ts)
  2. FTS5 search: messages_fts + meetings_fts (limit 20 each)
  3. If context.projectKey: secondary pass WHERE source_id LIKE 'BDS-%'
  4. Deduplicate, cap at 30 items
  5. analyzer.chatWithContext(history, message, contextItems)
       ↓
  { reply, suggestedFollowUps }
       ↓
Return { reply, sources, suggestedFollowUps }
```

History is **stateless on the server** — the client sends the full history array on every request (capped at 10 turns). No server-side sessions needed.

## Decisions Made

- **Persistent sidebar (right side, w-80)**: Always visible, doesn't interrupt the main content flow.
  - **Rejected**: Floating button overlay — obscures content, harder to multi-task with.
  - **Rejected**: Dedicated `/chat` page — forces navigation away from whatever the user is viewing.
- **Stateless server**: Client owns history, sends it each request. Simple, no session cleanup needed.
  - **Rejected**: Server-side session storage — adds complexity, state loss on server restart.
- **Model routing**: Haiku for short/simple questions (< 50 chars, no domain terms), Sonnet for complex queries. Reduces cost without visible quality drop for quick questions.
- **`sessionStorage` for history**: Survives page navigation within a session but cleared on browser refresh. This is intentional — chat history should not persist indefinitely on a local tool.
- **No streaming (MVP)**: The existing `api.ts` `request()` helper is non-streaming. Streaming adds significant complexity. The typing indicator (3 dots) provides perceived responsiveness.

## What Will Be Built

### `src/services/analyzer.ts` (edit)

Add new method to `AIAnalyzer`:

```ts
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  reply: string;
  suggestedFollowUps: string[];  // 2-3 short follow-up questions
}

async chatWithContext(
  history: ChatTurn[],
  message: string,
  contextItems: ContextItem[]   // reuse existing ContextItem from EP-13
): Promise<ChatResponse>
```

Model routing:
```ts
const isSimple = message.length < 50 && !/jira|bds|saturn|sprint|deploy/i.test(message);
const model = isSimple ? EXTRACTION_MODEL : DIGEST_MODEL;  // Haiku vs Sonnet
```

Tool schema for `chat_response`:
```ts
{
  name: 'chat_response',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      suggestedFollowUps: { type: 'array', items: { type: 'string' }, maxItems: 3 }
    },
    required: ['reply', 'suggestedFollowUps']
  }
}
```

System prompt: "You are a work intelligence assistant with access to the user's messages, Jira issues, Teams conversations, and meetings. Base your answers on the provided context. If you cannot find the answer, say exactly what you'd need to search for and ask the user if they'd like you to search live."

History capped at 10 turns — trim oldest first if `history.length > 10`.

### `web-server.js` (edit)

New endpoint: `POST /api/chat`

Request:
```ts
{
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  context: { page: string; projectKey?: string };
}
```

Response:
```ts
{
  reply: string;
  sources: { type: string; title: string; url?: string }[];
  suggestedFollowUps: string[];
}
```

Handler logic:
```js
const { message, history = [], context = {} } = body;

// FTS5 search
const keywords = extractKeywords(message);  // reuse from dist/tools/topic-expert.js
const ftsResults = db.prepare(`
  SELECT m.id, m.source, m.subject, m.content, m.author, m.timestamp, m.source_id
  FROM messages_fts fts
  JOIN messages m ON fts.rowid = m.id
  WHERE fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 20
`).all(keywords.join(' OR '));

// Secondary Jira pass if projectKey provided
if (context.projectKey) {
  const jiraResults = db.prepare(`
    SELECT * FROM messages WHERE source = 'jira' AND source_id LIKE ? LIMIT 10
  `).all(context.projectKey + '%');
  // merge + deduplicate
}

// Build ContextItem[] and call analyzer
const { AIAnalyzer } = await import('./dist/services/analyzer.js');
const analyzer = new AIAnalyzer({ apiKey: anthropicApiKey });
const chatResponse = await analyzer.chatWithContext(history.slice(-10), message, contextItems);

json(res, 200, {
  reply: chatResponse.reply,
  sources: contextItems.slice(0, 5).map(c => ({ type: c.source, title: c.title, url: c.url })),
  suggestedFollowUps: chatResponse.suggestedFollowUps,
});
```

### `web/src/store/chat.ts` (new)

```ts
import { create } from 'zustand';

export interface ChatMessage {
  id: string;          // crypto.randomUUID()
  role: 'user' | 'assistant';
  content: string;
  sources?: { type: string; title: string; url?: string }[];
  suggestedFollowUps?: string[];
  ts: number;          // Date.now()
}

interface ChatStore {
  messages: ChatMessage[];
  isLoading: boolean;
  sessionId: string;
  addUserMessage: (content: string) => string;           // returns id
  addAssistantMessage: (reply: string, sources: ChatMessage['sources'], followUps: string[]) => void;
  setLoading: (v: boolean) => void;
  clearSession: () => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: JSON.parse(sessionStorage.getItem('wi-chat-session') ?? '[]'),
  isLoading: false,
  sessionId: crypto.randomUUID(),
  addUserMessage: (content) => {
    const id = crypto.randomUUID();
    const msg: ChatMessage = { id, role: 'user', content, ts: Date.now() };
    const messages = [...get().messages, msg];
    set({ messages });
    sessionStorage.setItem('wi-chat-session', JSON.stringify(messages));
    return id;
  },
  addAssistantMessage: (reply, sources, followUps) => {
    const msg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant',
      content: reply, sources, suggestedFollowUps: followUps, ts: Date.now() };
    const messages = [...get().messages, msg];
    set({ messages });
    sessionStorage.setItem('wi-chat-session', JSON.stringify(messages));
  },
  setLoading: (v) => set({ isLoading: v }),
  clearSession: () => { set({ messages: [] }); sessionStorage.removeItem('wi-chat-session'); },
}));
```

### `web/src/store/ui.ts` (edit)

Add to `UIStore` interface:
```ts
chatOpen: boolean;
toggleChat: () => void;
```

Add to `create` call:
```ts
chatOpen: false,
toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
```

### `web/src/components/shared/ChatMessage.tsx` (new)

```tsx
// User bubble: right-aligned, rounded-tl-none, bg-[var(--accent)] text-white
// Assistant bubble: left-aligned, rounded-tl-none, bg-[var(--bg-2)], markdown rendered
// Source pills: small gray chips below assistant bubble (source type badges)
// Suggested follow-ups: ghost Button chips below latest assistant message only
```

### `web/src/components/shell/ChatPanel.tsx` (new)

```
┌─────────────────────────────┐
│ Assistant              Clear ✕ │  ← header
├─────────────────────────────┤
│                             │
│  [ChatMessage list]         │  ← flex-1, overflow-y-auto, gap-3, p-4
│                             │
│  [●●● typing indicator]     │  ← shown when isLoading
│                             │
├─────────────────────────────┤
│ [Textarea] [→ Send]         │  ← p-3, border-t
└─────────────────────────────┘
```

Key behaviors:
- Width: `w-80` (320px), flex-col, border-l, `bg-[var(--bg-2)]`
- Auto-scroll to bottom on new message
- Textarea: `rows=1`, auto-resize to max 4 rows via `onInput` height adjustment
- Enter = submit, Shift+Enter = newline
- `useLocation().pathname` auto-passed as `context.page`
- On submit: `addUserMessage` → `api.chat({ message, history, context })` → `addAssistantMessage`

### `web/src/components/shell/AppShell.tsx` (edit)

Current:
```tsx
<div className="flex flex-1 min-h-0">
  <main className="flex-1 overflow-y-auto p-6">{children}</main>
</div>
```

New:
```tsx
<div className="flex flex-1 min-h-0">
  <main className="flex-1 overflow-y-auto p-6 min-w-0">{children}</main>
  {chatOpen && <ChatPanel />}
</div>
```

### `web/src/components/shell/Sidebar.tsx` (edit)

Add `MessageSquare` icon button in the bottom section (above the existing collapse toggle):
```tsx
<button onClick={toggleChat} title="Toggle Chat"
  className={`p-2 rounded-lg transition-colors ${chatOpen ? 'bg-[var(--accent)] text-white' : 'hover:bg-[var(--bg-3)] text-[var(--muted)]'}`}>
  <MessageSquare size={18} />
</button>
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-24-1 | Add `chatWithContext()` to `AIAnalyzer` with Haiku/Sonnet routing — **File:** `src/services/analyzer.ts` | ✅ Done |
| EP-24-2 | Add `POST /api/chat` endpoint — **File:** `web-server.js` | ✅ Done |
| EP-24-3 | Create `useChatStore` with sessionStorage persistence — **File:** `web/src/store/chat.ts` | ✅ Done |
| EP-24-4 | Add `chatOpen` + `toggleChat` to `useUIStore` — **File:** `web/src/store/ui.ts` | ✅ Done |
| EP-24-5 | Add `ChatRequest`/`ChatResponse` types + `api.chat()` — **File:** `web/src/lib/api.ts` | ✅ Done |
| EP-24-6 | Build `ChatMessage` component (user/assistant bubbles + source pills) — **File:** `web/src/components/shared/ChatMessage.tsx` | ✅ Done |
| EP-24-7 | Build `ChatPanel` component (layout + input + typing indicator) — **File:** `web/src/components/shell/ChatPanel.tsx` | ✅ Done |
| EP-24-8 | Modify `AppShell` to render `<ChatPanel />` conditionally — **File:** `web/src/components/shell/AppShell.tsx` | ✅ Done |
| EP-24-9 | Add chat toggle button to `Sidebar` — **File:** `web/src/components/shell/Sidebar.tsx` | ✅ Done |
| EP-24-10 | Add `sendToChat(msg)` + `pendingChatMessage` to `useUIStore` for external injection — **File:** `web/src/store/ui.ts`, `web/src/components/shell/ChatPanel.tsx` | ✅ Done |

## Acceptance Criteria

- [ ] `POST /api/chat` returns `reply`, `sources`, `suggestedFollowUps`
- [ ] Multi-turn conversation works (history sent each request, capped 10 turns)
- [ ] Chat panel opens/closes via sidebar toggle
- [ ] Page context (`location.pathname`) auto-passed to every request
- [ ] Suggested follow-ups render as clickable chips and auto-fill the input
- [ ] Typing indicator (3 animated dots) shown during API call
- [ ] Session history survives page navigation (sessionStorage)
- [ ] History cleared on "Clear" button click
- [ ] Main content is not obscured (min-w-0 preserved)
- [ ] `npm run typecheck` passes with zero errors

## Sample Prompts

```
"What happened in the Saturn project yesterday?"
→ Searches DB for Saturn-tagged messages from yesterday, synthesizes with Claude

"Who is working on PROJ-15057?"
→ Searches Jira messages for that issue key, returns assignee + recent comments

"What are the open blockers?"
→ Searches action_items WHERE status = 'open' + messages with "blocked" keyword

"What decisions were made in the last standup?"
→ Searches meetings_fts for recent meeting summaries + decisions

"I can't find anything about the API migration"
→ Claude responds: "I found 0 results. Would you like me to search live in Jira?"
```
