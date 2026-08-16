/**
 * v57 — Phase 78a: Chat fix only — chat_modes + chat_messages tables.
 *
 * Two net-new tables ship together:
 *   1. `chat_modes` — one row per `conversation_id`. Records the most-recent
 *      detected mode (work | life | ambiguous), the signals + confidence the
 *      detector emitted, plus an optional `manual_mode` override that takes
 *      precedence when the user pinned a mode chip in the UI. Updated via
 *      UPSERT (ON CONFLICT(conversation_id) DO UPDATE) on every /api/chat POST
 *      so the row reflects the latest turn.
 *   2. `chat_messages` — one row per chat turn (user + assistant). Mode-tagged
 *      so downstream filters (Phase 79 split canaries, telemetry, life-mode
 *      filter in Phase 78c) can scope by mode without rescanning content.
 *      `private_turn` flag is reserved for Phase 78c privacy toggle; in 78a
 *      every row is persisted with private_turn=0.
 *
 * CHECK constraints (D-78a-02 in 78a-CONTEXT.md):
 *   - chat_modes.last_detected ∈ {'work','life','ambiguous'}
 *   - chat_modes.manual_mode  ∈ {NULL,'work','life'}    (NULL = auto)
 *   - chat_messages.role      ∈ {'user','assistant'}
 *   - chat_messages.mode      ∈ {NULL,'work','life','ambiguous'}
 *   - chat_messages.private_turn ∈ {0, 1}
 *
 * Indexes:
 *   - idx_chat_messages_conv_ts (full)        — for fetching a conversation's
 *     messages in time order (the hot path on chat render).
 *   - idx_chat_messages_mode_ts (partial)      — for mode-scoped queries
 *     (telemetry, Phase 79 canaries). Partial WHERE mode IS NOT NULL keeps
 *     the index small; pre-mode rows (none in 78a, but defensive) are skipped.
 *   - idx_chat_messages_private (partial)      — for the privacy filter in
 *     Phase 78c. Partial WHERE private_turn = 1 keeps the index near-empty
 *     in 78a (where everything is private_turn=0).
 *
 * Net-new, no FK rewiring needed. Mirrors the v53/v54/v55/v56 idempotent
 * pattern — CREATE TABLE / INDEX IF NOT EXISTS — so re-running the migration
 * is a no-op.
 *
 * No new model_config bucket. Per 78a-SPEC, mode detection is heuristic-only
 * (no LLM fallback), so there is no 9th bucket to seed.
 *
 * Refs: .planning/phases/78a-chat-fix-only/78a-SPEC.md § Requirements item 8
 *       .planning/phases/78a-chat-fix-only/78a-CONTEXT.md § D-78a-01..03
 *       .planning/phases/78-unified-buddy-chat/PLAN.md § 78a-01
 */
import Database from 'better-sqlite3';

export default function migrateV57(db: Database.Database): void {
  // ── 1. chat_modes — one row per conversation, UPSERTed on every turn ──────
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_modes (
      conversation_id TEXT PRIMARY KEY,
      manual_mode TEXT
        CHECK (manual_mode IS NULL OR manual_mode IN ('work', 'life')),
      last_detected TEXT NOT NULL
        CHECK (last_detected IN ('work', 'life', 'ambiguous')),
      last_signals TEXT NOT NULL DEFAULT '[]',
      last_confidence REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  // ── 2. chat_messages — one row per user/assistant turn, mode-tagged ───────
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      mode TEXT
        CHECK (mode IS NULL OR mode IN ('work', 'life', 'ambiguous')),
      private_turn INTEGER NOT NULL DEFAULT 0
        CHECK (private_turn IN (0, 1)),
      ts INTEGER NOT NULL,
      metadata TEXT
    );
  `);

  // ── 3. Indexes (one full + two partial) ───────────────────────────────────
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_conv_ts
      ON chat_messages(conversation_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_mode_ts
      ON chat_messages(mode, ts) WHERE mode IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_private
      ON chat_messages(private_turn) WHERE private_turn = 1;
  `);
}
