---
sidebar_label: "Unified Buddy Chat (Phase 78)"
sidebar_position: 34
---

# Unified Buddy Chat — Architecture View

> **Status:** Proposed (Phase 78). Sliced 78a → 78b → 78c by adversarial review. The formal plan lives in [`.planning/phases/78-unified-buddy-chat/PLAN.md`](https://github.com/syedmaaz/work-intelligence-mcp/blob/main/.planning/phases/78-unified-buddy-chat/PLAN.md). The user-facing executive summary lives in [`PHASE-78-SUMMARY.md`](https://github.com/syedmaaz/work-intelligence-mcp/blob/main/.planning/PHASE-78-SUMMARY.md).
> **Date:** 2026-06-07
> **Source workflow:** `wf_cfec2d68-5a7` — 14 agents (4 inventory + 7 design + 3 adversarial), 1.6 M tokens.

---

## The problem (plain English)

Three pains converged in early June 2026:

1. **The WI web chat loses context.** Today's `/api/chat` does not call `/api/persona`, does not call `brain.getDecision`, does not pass tools to the model, and has no mode awareness. The model can't suggest "want me to fire `wi-investigate`?" because it doesn't know `wi-investigate` exists. Every turn rebuilds context from scratch via FTS+grep+ResearchEngine without a stable persona or memory anchor.
3. **Hermes Agent ruled out:** Same SIR posture rejects any third-party `curl | bash` agent runtime — see [HERMES-AGENT-RECHECK-2026-06-07.md](https://github.com/syedmaaz/work-intelligence-mcp/blob/main/.planning/HERMES-AGENT-RECHECK-2026-06-07.md).

The user accepted single-surface (work + life in one chat box) for v1, with explicit willingness to split if it doesn't work. **Single-surface is an MVP shortcut, not a stable architecture** — adversarial review identified five canaries forcing a Phase 79 split within 6–10 weeks under realistic usage.

---

## Today's chat in detail (inventory)

### What ChatPanel renders today (`web/src/components/shell/ChatPanel.tsx`, 600 lines)

| Surface | Behaviour |
|---|---|
| Drag-resizable handle | Sidebar mode, `localStorage('wi-chat-width')` |
| Session list sidebar | New chat / per-session delete / relativeTime |
| Header strip | Active session title, `Powered by Claude` subtitle, Trash2/X |
| Message list | `DecisionCard` (when decision-shaped) OR `<ChatMessage>` |
| TypingIndicator | Optional `researchHint` (3s timer) + `brainStage` label |
| Input | Auto-grow textarea (cap 112px), Enter sends, Shift+Enter newline |

NOT present today: mode/persona switcher, sources panel, follow-ups strip, history pagination, tool cards, reminder cards, privacy toggle.

### What `/api/chat` builds today (`web-server.js` lines 4560-5082)

In order:

1. `buildBrainContext(db, BRAIN_USER, {palace})` → `brainContextToContextItems`
2. `fetchWorkContextForChat(db, message)` → Teams items + gaps; short-circuits with `buildDataGapReply` if `shouldOfferSync`
3. `messages_fts` + `meetings_fts` BM25 over last 90 days
4. `codebase_knowledge` LIKE-search for `repo='example-service'`
5. Code-grep on `./repos/example-service` via `grep -rl` + snippets ±5/+70
6. ResearchEngine (ADR-020) — proactive on `needsDeepResearch` OR fallback when grep returns 0
7. `injectedContext` (when ticket detail panel) prepended as "Referenced Jira Tickets"
8. EP-67 Claude Code runner (gated)
9. MemPalace `search` + KG query + KG traversal (500ms timeout, parallel)
10. `embeddingsRankList(message, db, 25)` — pure-semantic 5th lane
11. RRF fusion of 5 lanes + `rankContextItems` recency + relevance
12. `analyzer.chatWithContext(history, message, rankedItems, undefined, 2048)` — final answer

### What's missing

| Capability | Today | Phase 78 fix |
|---|---|---|
| `/api/persona` injection | ✗ never called | 78a system block prepend |
| `brain.getDecision` integration | only on decision-shaped Q&A (client regex) | 78a integrate properly |
| Anthropic `tool_use` for skills | ✗ no tools passed to model | 78b agent loop |
| Mode awareness | ✗ one undifferentiated path | 78a heuristic detector |
| Reminder intent intercept | ✗ chat can't fire `remindctl` | 78c regex parse |
| Privacy toggle | ✗ no surface | 78c 🔒 Don't remember |
| Life-mode persona | ✗ no `life_facts`, no 7th wing | 78c MemPalace + schema v60 |

---

## Architecture overview (post-Phase 78c)

```
User types in ChatPanel
       │   (mode chips: 🛠 Work | 🤝 Life | 🤔 Auto)
       ▼
POST /api/chat { message, mode?, history, ... }
       │
       ▼
┌─────────────────────────────────────────────────┐
│ src/services/chat/mode-detect.ts                │
│ Heuristic-only (no LLM):                        │
│  • slash command       +10 → WORK               │
│  • Jira key            +5  → WORK               │
│  • file/PR ref         +5  → WORK               │
│  • IMPERATIVE VERB     +8  → WORK  ← adv. fix   │
│  • mood word           +5  → LIFE               │
│  • family/personal     +5  → LIFE               │
│  • persistence         +2  ONLY if prior ≥0.7   │
│ Manual chip override always wins.               │
│ Returns {mode, confidence, signals[]}           │
└──────┬──────────────────────────────────────────┘
       │
       ▼  (78c-only: invert privacy default if life && conf<0.85)
┌─────────────────────────────────────────────────┐
│ src/services/chat/reminder-intent.ts (78c)      │
│ Regex parse BEFORE LLM call:                    │
│   /remind me to (.+?)( by | at | tomorrow ...)/ │
│ Match → chrono-node date parse → POST           │
│   /api/reminders → remindctl → iPhone via       │
│   iCloud. Reply card; LLM never invoked.        │
│ No match → fall through.                        │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ /api/persona?mode=X → cached system block       │
│   WORK (1500 tok): role + tech + Jira keys      │
│   LIFE (1200 tok): family + values + concerns   │
│   MIXED (1800 tok): both, half strength         │
│ Anthropic prompt-cache: cache_control: ephemeral│
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ recall_memory(wings=[mode-scoped], limit=5)     │
│  WORK → wings: decisions, jira, code, conv      │
│  LIFE → wings: life ONLY (78c)                  │
│ MANDATORY enforcement in recall.ts.             │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ analyzer.chatWithContext + tool_use[36] (78b)   │
│ Agent loop:                                     │
│   max 3 turns per user msg                      │
│   max 5 tools per turn                          │
│   read skills auto-execute server-side          │
│   write skills → pendingConfirmations[]         │
│   per-user per-hour cap = 60 (budget.ts)        │
└──────┬──────────────────────────────────────────┘
       │
       ▼
Response: {reply, sources, toolCalls?, pendingConfirmations?,
           actionTaken?, detectedMode, modeSignals[]}
       │
       ▼
ChatPanel renders:
  • Reply text (markdown, linkified)
  • Tool cards (78b): collapsed badge OR [Run] [Cancel]
  • Reminder cards (78c): 🔔 banner, [Open Reminders] [Undo]
  • Persona footer: "Mode: 🛠 Work — knows your stack"
```

---

## Mode detection (78a)

### Signal weight table

| Signal | Weight | Direction | Example |
|---|---|---|---|
| Slash command (`/wi-...`) | +10 | WORK | `/wi-investigate PROJ-15702` |
| Jira key (`[A-Z]+-\d+`) | +5 | WORK | "what blocks PROJ-15257?" |
| File path / PR ref | +5 | WORK | "look at PR #4080" |
| **Imperative verb** ← adversarial fix | +8 | WORK | "investigate", "fix", "review", "deploy", "draft" |
| Mood word | +5 | LIFE | "stressed", "tired", "frustrated" |
| Family/personal | +5 | LIFE | "my kid", "trip", "vacation" |
| AI-about-feelings | +5 | LIFE | "am I overreacting" |
| Persistence (last mode) | +2 | inherits | only when prior turn confidence ≥ 0.7 |

### Memory-scope vs tone (adversarial fix)

The persona is split into two layers:

- **Memory-scope (hard partition by mode):** which palace wings, which `recall_memory` wings, which `claude-mem` filter — non-negotiable, server-enforced.
- **Tone (soft, can read across modes):** mood words detected in a WORK message adjust tone (warmer, acknowledges stress) without changing memory partition.


### Telemetry (smoke § 17 + observability)

- `mode_detection_override_rate` — rolling 7-day, per session
- `mode_source_count` — auto vs manual frequency
- SLO: < 15% manual override rate. Above 25% for 3 days → detector retune.

---

## Persona injection per mode (78a + 78c)

### WORK persona block (~1500 tokens)

Sources:
- `MEMORY.md user_preferences` (already-shipped substrate fix #1: `src/routes/persona.ts`)
- `user_profile_observations` rolling 7-day aggregates (kinds + targets)
- Top-5 recurring Jira keys from messages (last 30 days)
- Top-3 recent `brain_decisions` confidence-weighted

### LIFE persona block (~1200 tokens — 78c-gated)

Sources:
- NEW `life_facts` table (manually-asserted family / values / preferences / concerns / goals / moods / interests)
- Recent moods (last 7 days, decay-weighted)
- NO Jira data, NO code data, NO Teams thread context

### MIXED/AMBIGUOUS (~1800 tokens)

WORK + LIFE at half strength, plus one clarifying question. Triggered ONLY when no explicit referent exists.

### Caching

Anthropic prompt-caching with `cache_control: { type: 'ephemeral' }` on the persona+manifest blocks. Persona version hash differs across `(user, mode)` tuples, stable within tuple — same key on consecutive calls = cache HIT.

---

## Skill dispatch via Anthropic tool_use (78b)

### Catalog generation

`src/services/router/skill-catalog.ts` (reused from ADR-033 if landed):

- Pull from `src/tools/manifest.ts` TOOL_MANIFEST
- Join with each skill's SKILL.md frontmatter (`name`, `description`, `argument-hint`)
- Tag categories: investigative / retrieval / **action-write** / meta / reminder / life
- Action-write skills (5): `wi-update-context`, `wi-bug-resolve`, `wi-bug-resolve-all`, `wi-save-to-ticket`, `wi-sync` — `requires_confirmation: true` baked in at catalog generation time, NOT at runtime
- Deprecated stubs get hardcoded Beta(1, 10) prior — visible but disprefered
- Boot validation: stderr warning if disk has wi-* skill missing from TOOL_MANIFEST or vice versa

### Agent loop

`src/services/chat/agent-loop.ts`:

```
loop:
  while turns < 3:
    call Anthropic with tools=catalog (mode-filtered)
    if response only has text blocks → return reply
    if tool_use blocks:
      for each (max 5/turn):
        if read-category: dispatch server-side, append tool_result
        if write-category: emit pendingConfirmation, return EARLY
    turns += 1
  hard-stop at 3 turns: return reply with limitHit='turns'
```

### Confirmation flow

Write-skill response includes `pendingConfirmations[]` with `confirmationId`. Chat returns immediately with `[Run] [Cancel]` cards. User clicks Run → `POST /api/chat/confirm-tool { confirmationId, decision: 'run' }` → side-effect fires → result threaded back as `tool_result` on next turn.

This mirrors ADR-030's `BUG_AUTO_MERGE=0` invariant. Non-negotiable.

### Per-user per-hour cap

60 chat-with-tools calls per hour per user, enforced via existing `src/services/brain/budget.ts`. Smoke § 18 includes a runaway-loop test.

---

## Reminder intercept (78c)

### Server-side regex parse — BEFORE LLM call

```ts
const REMINDER_RE = /^(remind me to |don't let me forget |set a reminder for )(.+?)( by | at | on | tomorrow | tonight | next week | in \d+ (min|hour|day|week))?$/i;
```

If matched:
- Parse `body` and optional `due` via **chrono-node**
- List default: `'Atlas'` (work-mode) or `'Personal'` (life-mode)
- WORK mode: fire immediately via `remindctl`, return reply card
- LIFE mode: ALWAYS confirm — return `actionTaken.kind === 'reminder_pending_confirmation'`
- Persist intent to `reminder_intents` table, attach `reminderctl_uuid` after fan-out

If not matched: fall through to LLM agent loop (the `wi_remind` tool may still get called by the model).

### Why server-side instead of LLM tool

Saves Opus tokens for trivial reminders (~200ms vs ~3s end-to-end). Deterministic. Doesn't need the model to be in the right mode.

### List/cancel from chat

"What reminders do I have?" → `GET /api/reminders?status=pending` → render 5-item list with `[Done]` `[Snooze]` `[Delete]` buttons. Same `wi-remind` skill backend.

---

## ChatPanel UI evolution

### 78a additions

| Component | File | LOC | Purpose |
|---|---|---|---|
| `ModeChips` | `web/src/components/chat/ModeChips.tsx` | 60 | Top-right chips 🛠 Work / 🤝 Life / 🤔 Auto |
| `ConversationHeader` | `web/src/components/chat/ConversationHeader.tsx` | 70 | Mode emoji + persona summary |
| `PersonaFooter` | `web/src/components/chat/PersonaFooter.tsx` | 40 | Subtle mode-change footer |
| ChatPanel modifications | `web/src/components/shell/ChatPanel.tsx` | +110 | Render dispatchers, mode state |

Mode persists per conversation (`sessionStorage`), resets on new conversation.

### 78b additions

| Component | File | LOC | Purpose |
|---|---|---|---|
| `ToolCard` | `web/src/components/chat/ToolCard.tsx` | ~180 | Read-skill collapsed badge OR write-skill `[Run] [Cancel]` |

Style: bordered, slightly tinted, compact — does not dominate chat.

### 78c additions

| Component | File | LOC | Purpose |
|---|---|---|---|
| `ReminderActionCard` | `web/src/components/chat/ReminderActionCard.tsx` | ~160 | 🔔 banner, due date, `[Open Reminders]` `[Undo]` |
| `PrivacyModeToggle` | `web/src/components/chat/PrivacyModeToggle.tsx` | ~40 | 🔒 Don't remember |

`[Open Reminders]` button uses `x-apple-reminderkit://` URL on iOS, silent fall-back on Mac.

---

## Privacy + envelope safety

### What crosses where

| Data path | Destination | Status |
|---|---|---|
| Chat prompt + response | Hai proxy → Claude Opus | internal-confidential |
| Chat history | `~/.work-intelligence-mcp/data.db` | Local-only on `kt7vjwfvxl-4` |
| `claude-mem` observations | `~/.claude/projects/.../memory/` | Local-only on `kt7vjwfvxl-4` |
| MemPalace drawers | `MEMPALACE_PATH` (default local) | Local-only on `kt7vjwfvxl-4` |
| Apple Reminders / Notes | iCloud (Maaz personal Apple ID) | Personal envelope |

### Safety controls

1. **LIFE wing isolation** — `recall_memory` server-side filter. WORK-mode recall NEVER queries `wing='life'`. Smoke § 20.3 asserts via synthetic `CANARY_LIFE_FACT_8F2A` seed.
2. **Privacy toggle (🔒 Don't remember)** — per-turn, skips `claude-mem` write, MemPalace enrichment, `brain_decisions` persistence. Audit row records mode + timestamp + token count only (no content).
3. **Inverted privacy default for low-confidence life classifications (adversarial fix #1)** — if `detectedMode==='life' && confidence < 0.85`, `private_turn = 1` defaults TRUE. Forgetting → MORE privacy.
4. **No cross-mode auto-summary** — `claude-mem` session observations get a `mode` tag; default search filters by current mode.
5. **Hai proxy disclosure tooltip** — first-life-mode-use banner: *"Life-mode chat goes through Hai proxy and Claude Opus. Treat it as internal-confidential, not strictly personal. For deeply private journaling, use claude.ai mobile or Apple Notes directly."*
6. **Colleague-name redaction** — CHECK constraint or audit trigger: REFUSE inserts where `mode='life' AND privacy='remember'` AND content matches a configurable colleague-name list at `~/.work-intelligence-mcp/colleague-redact-list.txt`.
7. **Export-and-wipe via CLI** — `npm run life:export` (JSON to stdout), `npm run life:wipe` (DELETE life_facts + DELETE chat_messages WHERE mode='life').

### Five Phase 79 split canaries

| # | Canary | Trigger threshold |
|---|---|---|
| 1 | `mode_detection_override_rate` | > 25% for 3 consecutive days |
| 2 | `privacy_toggle_flip_count` | median < 0.3 with life-mode usage > 5 turns/day |
| 3 | `wing_isolation_smoke` | fails once (any synthetic life-canary in work query) |
| 4 | `chat_message_delete_count` | > 0 (user manually deleted any sent message) |
| 5 | Weekly grep for  colleague names in life-mode `chat_messages` | returns > 0 rows |

ANY single canary firing → spec Phase 79 split that week.

---

## Schema (v59 + v60)

### v59 — `chat_modes` + `chat_messages` (78a)

```sql
CREATE TABLE chat_modes (
  conversation_id   TEXT PRIMARY KEY,
  manual_mode       TEXT CHECK (manual_mode IS NULL OR manual_mode IN ('work','life')),
  last_detected     TEXT NOT NULL DEFAULT 'ambiguous'
                    CHECK (last_detected IN ('work','life','ambiguous')),
  last_signals      TEXT NOT NULL DEFAULT '[]',  -- JSON array
  last_confidence   REAL NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE chat_messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content           TEXT NOT NULL,
  mode              TEXT CHECK (mode IS NULL OR mode IN ('work','life','ambiguous')),
  private_turn      INTEGER NOT NULL DEFAULT 0 CHECK (private_turn IN (0,1)),
  ts                INTEGER NOT NULL,
  metadata          TEXT  -- JSON: sources, suggestedFollowUps, tool_calls (78b adds), needsSync
);

CREATE INDEX idx_chat_messages_conv_ts ON chat_messages(conversation_id, ts);
CREATE INDEX idx_chat_messages_mode_ts ON chat_messages(mode, ts DESC);
CREATE INDEX idx_chat_messages_private ON chat_messages(private_turn) WHERE private_turn = 1;
```

### v60 — `life_facts` + `reminder_intents` (78c)

```sql
CREATE TABLE life_facts (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN
                      ('family','value','preference','concern','goal','mood','interest')),
  body                TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual','imported','inferred')),
  added_at            INTEGER NOT NULL,
  last_referenced_at  INTEGER,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes               TEXT
);
CREATE INDEX idx_life_facts_kind_active ON life_facts(kind, active);

CREATE TABLE reminder_intents (
  id                  TEXT PRIMARY KEY,
  chat_message_id     TEXT,        -- FK-shaped, no hard constraint
  body                TEXT NOT NULL,
  due_iso             TEXT,        -- ISO-8601, nullable for "later" intents
  list_name           TEXT NOT NULL DEFAULT 'Atlas',
  reminderctl_uuid    TEXT,        -- attached after fan-out
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_reminder_intents_created ON reminder_intents(created_at DESC);
CREATE INDEX idx_reminder_intents_chat    ON reminder_intents(chat_message_id);
```

### Migration version dependency

| Version | Owner | Status |
|---|---|---|
| v56 | Current head | shipped |
| v57 | ADR-033 router_decisions | proposed |
| v58 | ADR-032 reviews wing | proposed |
| v59 | Phase 78a chat_modes + chat_messages | this phase |
| v60 | Phase 78c life_facts + reminder_intents | this phase |

If ADR-033 / ADR-032 slip, Phase 78 takes the next free integers. Migration loader's `fromVersion..CURRENT_SCHEMA_VERSION` is dependency-safe.

---

## Phased rollout

| Week | Phase | Deliverable | Gate |
|---|---|---|---|
| 1 | 78a execute | Mode chips, persona injection, schema v59, smoke § 17 | smoke § 17 green |
| 2 | (soak) | Telemetry collection | `override_rate < 15%`, life-flip count > 0 |
| 3-4 | 78b execute (gated) | Skills as tools, agent loop, smoke § 18 | smoke § 18 green |
| 5 | (soak) | Tool dispatch validation | ≥ 10 `tool_use` turns logged |
| 6-8 | 78c execute (gated AND conditional) | Life mode, reminders, schema v60, smoke § 19 + § 20 | smoke § 19/20 green |
| 9+ | Phase 79 | Split work + life surfaces | Triggered by canary |

If 78a soak shows zero life-mode flips → kill 78c, ship work-mode-only.

---

## Adversarial findings honored

| Attack # | Verdict | Honored by |
|---|---|---|
| 0 — Single-surface won't hold past 6–10 weeks | feasible_with_scoping_changes | Phase 79 on roadmap from day 1 with 5 canaries; pre-emptive design hedges in 78c-04 / 78c-07 |
| 1 — Three-mode design correct in shape but heuristic too rigid | revised | Imperative-verb signal +8; persistence ≥0.7 prior gating; AMBIGUOUS triggers only when no explicit referent; persona split memory-scope (hard) vs tone (soft) |
| 2 — Phase 78 over-scoped, slice it | confirmed | Three sub-phases (78a/b/c); v59 + v60 split migrations; CLI not UI for life-facts; 4 smoke sections deferred to phase that adds the surface |

---

## Operational characteristics

### Latency budget per chat turn

| Path | Cold cache | Warm cache |
|---|---|---|
| Mode detect (heuristic) | ~5ms | ~5ms |
| Reminder intent regex | ~3ms | ~3ms |
| Persona block (cached) | ~50ms | ~5ms |
| Recall (5 wings parallel) | ~80ms | ~30ms |
| Anthropic Opus call (text-only) | 1500-3000ms | (cache HIT on system block) 800-1500ms |
| Agent loop (tool_use, 1 turn) | +1500-3000ms | +800-1500ms |
| Total p50 (text-only WORK) | ~2.0s | ~0.9s |
| Total p50 (tool_use, 2 turns) | ~5.0s | ~3.5s |

### Token budget

| Block | Tokens |
|---|---|
| WORK persona | 1500 |
| LIFE persona | 1200 |
| MIXED persona | 1800 |
| Skill catalog (78b) | ~2000 (36 tools × ~55 tokens each) |
| Recall (5 items × ~150 tokens) | ~750 |
| User message + history (last 10) | ~2000 |
| Total system+context typical | ~6000-7000 input tokens / turn |


### Failure-mode dictionary

| Symptom | Likely cause | First action |
|---|---|---|
| Chat returns generic answer despite Jira context | Persona block missed cache | Verify `/api/persona?mode=work` returns hit; check Anthropic cache_control |
| Mode chip auto-flips wrong way | Heuristic miscalibration | Check `mode_detection_override_rate`; tune signal weights |
| Tool card shows wrong skill | Catalog out of sync | Run `bash scripts/install-skills.sh`; verify `wi_*` symlinks |
| Reminder fires twice | Intent regex matched + LLM called `wi_remind` | Add server-side dedup on `(body, due, user)` |
| Life content surfaces in WORK chat | Wing isolation broke | Run `npm run smoke:wing-isolation`; trace recall query logs |
| Per-hour cap hit | Runaway loop | `DELETE FROM brain_budget WHERE bucket='decide' AND user='...'` |
| Cache miss on minor rephrasing | Normalization too narrow | Aggressive lowercase + collapse + strip-punctuation in cache key |

---

## Smoke test additions

### § 17 (78a) — Mode detection
6 cases: WORK happy path with slash command + Jira key, LIFE happy path with mood word, AMBIGUOUS triggers clarify, override beats heuristic, **imperative-verb canary** (`"I'm exhausted, investigate PROJ-15702"` MUST route WORK), persona mode-aware.

### § 18 (78b) — Agent loop
5 cases: text-only response terminates loop, write-skill never auto-executes (`pendingConfirmations.length===1`), Run path completes side-effect, Cancel path threads tool_result, hard-stop at 3 turns.

### § 19 (78c) — Reminder intercept
5 cases: WORK fires immediately (Atlas list, `apple_id != null`), LIFE confirms (zero rows until confirmed), GET pending shows row, PATCH completes, DELETE removes from SQLite + remindctl.

### § 20 (78c) — Privacy envelope
4 cases: privacy toggle skips claude-mem write, skips MemPalace enrichment, **wing isolation holds** (synthetic `CANARY_LIFE_FACT_8F2A` never appears in 50 work-mode queries), low-confidence life-mode auto-defaults `private_turn=1`.

Total: **20 new smoke cases** across the 3 sub-phases.

---

## Cross-references

- [ADR-033 `/wi` Skill Router](../adr/adr-033-wi-router) — sibling, both touch the chat surface; coordinate to avoid duplicating `skill-catalog.ts`.
- [ADR-032 Persona Memory Loop](../adr/adr-032-persona-memory-loop) — consumes the persona block this builds; `reviews` wing depends on this work shipping first.
- [ADR-030 Self-Healing Bug Loop](../adr/adr-030-self-healing-bug-loop) — `BUG_AUTO_MERGE=0` invariant inspires write-skill confirmation pattern.
- [ADR-031 Per-Bucket Model Config](../adr/adr-031-per-bucket-model-effort-config) — `decide` bucket reused; do not add a 9th bucket.
- [ADR-024 Unified Brain](../adr/adr-024-unified-brain) — reused: `brain.getDecision`, `recall_memory`, `record_outcome`.
- [`HERMES-AGENT-RECHECK-2026-06-07.md`](https://github.com/syedmaaz/work-intelligence-mcp/blob/main/.planning/HERMES-AGENT-RECHECK-2026-06-07.md) — third-party runtime ruled out.
- Workflow run: `wf_cfec2d68-5a7` (14 agents, 1.6M tokens).
- Design payload: `/tmp/phase78-payload.json` (212KB structured JSON).
