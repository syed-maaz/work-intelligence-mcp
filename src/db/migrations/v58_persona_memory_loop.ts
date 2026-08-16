/**
 * v58 — Phase 80 / Wave 77a-01: Persona Memory Loop foundation.
 *
 * Five net-new tables ship together (per ADR-032 § Schema, with BLOCKER 1-4
 * fixes applied and BLOCKER-3's SQL counter on the snapshots table):
 *
 *   1. `pr_review_comments` — Tier-1 raw signal. One row per GitHub review
 *      comment (after backfill in 77a-04). Bot comments preserved with
 *      `is_bot=1` (BASELINE.md: 169/295 = 57% are bots — must filter
 *      upstream of clustering, never in clustering).
 *   2. `lessons_learned` — extracted lesson candidates (filled by 77a-03
 *      canonical-prose extractor + 77b extraction agent). `status` enum
 *      gates the propose-then-approve loop: 'candidate' → 'promoted' or
 *      'dismissed'. Negative-training preserved via `dismissal_reason`.
 *   3. `rule_cards` — Active rules. Body lives in palace as drawer; this
 *      table holds the SQL pointer + tier + scope (activation glob).
 *      Counters live here (NOT in palace body_yaml) per BLOCKER-3 fix.
 *   4. `code_diff_outcomes` — forward-looking signal source 1.2: when a
 *      rule was cited and the user accepted/rejected the diff. Filled by
 *      77c citation parser. 77a-01 creates the table only.
 *   5. `persona_rule_snapshots` — durability + replay. Every promotion
 *      writes a row here so `palace:rebuild` can re-emit the palace
 *      drawer deterministically. PERSONA-A-11 + A-12 ACs.
 *
 * Wave context: schema v57 was bumped by 78a (chat_modes + chat_messages).
 * v58 = persona memory loop foundation. Mirrors the v53 (bug-loop) pattern.
 *
 * All five tables are dual-purpose:
 *   - Tier-0 / Tier-1 raw signal lives in `pr_review_comments` only;
 *     parsers write directly to palace + `rule_cards` + `persona_rule_snapshots`.
 *   - Tier-1 extracted candidates live in `lessons_learned`.
 *   - Active rules + counters live in `rule_cards`.
 *   - Outcomes (accept/reject diff) live in `code_diff_outcomes`.
 *   - Replay seed lives in `persona_rule_snapshots`.
 *
 * CHECK constraints:
 *   - pr_review_comments.is_bot ∈ {0, 1}
 *   - lessons_learned.status ∈ {'candidate', 'promoted', 'dismissed'}
 *   - lessons_learned.source_kind ∈ {'pr_review', 'canonical_prose', 'tier0_static', 'manual'}
 *   - rule_cards.tier ∈ {0, 1}
 *   - rule_cards.status ∈ {'active', 'retired', 'stale'}
 *   - code_diff_outcomes.outcome ∈ {'accepted', 'rejected', 'partial'}
 *
 * Indexes (hot paths):
 *   - idx_pr_review_comments_pr — by (repo, pr_number) for backfill dedupe
 *   - idx_pr_review_comments_bot — partial WHERE is_bot=0 (clustering hot path)
 *   - idx_lessons_learned_status — for /setup/persona Pending tab
 *   - idx_rule_cards_tier_status — for recall fan-out scoping
 *   - idx_persona_rule_snapshots_active — partial WHERE retired_at IS NULL
 *
 * MEMENTO: this migration ALSO ensures `model_config` has 8 buckets for
 *   ADR-031 parity — the persona-extract bucket lives at v58 (initial values
 *   inserted only if missing; idempotent INSERT OR IGNORE).
 */

import type Database from 'better-sqlite3';

export default function migrateV58(db: Database.Database): void {
  // ── 1. pr_review_comments — Tier-1 raw signal ─────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_review_comments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      repo            TEXT    NOT NULL,
      pr_number       INTEGER NOT NULL,
      comment_id      INTEGER NOT NULL,
      author          TEXT    NOT NULL,
      is_bot          INTEGER NOT NULL DEFAULT 0 CHECK(is_bot IN (0,1)),
      body            TEXT    NOT NULL,
      file_path       TEXT,
      line_number     INTEGER,
      diff_hunk       TEXT,
      created_at      TEXT    NOT NULL,
      thread_resolved INTEGER NOT NULL DEFAULT 0 CHECK(thread_resolved IN (0,1)),
      raw_json        TEXT,
      ingested_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo, comment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pr_review_comments_pr
      ON pr_review_comments(repo, pr_number);
    CREATE INDEX IF NOT EXISTS idx_pr_review_comments_bot
      ON pr_review_comments(author, created_at) WHERE is_bot = 0;
  `);

  // ── 2. lessons_learned — propose-then-approve gate ────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons_learned (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      title               TEXT    NOT NULL,
      body                TEXT    NOT NULL,
      source_kind         TEXT    NOT NULL CHECK(source_kind IN
                            ('pr_review','canonical_prose','tier0_static','manual')),
      source_ref          TEXT,
      status              TEXT    NOT NULL DEFAULT 'candidate'
                            CHECK(status IN ('candidate','promoted','dismissed')),
      promoted_to_rule_id INTEGER,
      dismissal_reason    TEXT,
      cluster_size        INTEGER,
      mixed_author        INTEGER NOT NULL DEFAULT 0 CHECK(mixed_author IN (0,1)),
      embedding           BLOB,
      extractor_prompt_hash TEXT,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      promoted_at         TEXT,
      dismissed_at        TEXT,
      FOREIGN KEY (promoted_to_rule_id) REFERENCES rule_cards(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_learned_status
      ON lessons_learned(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_lessons_learned_source
      ON lessons_learned(source_kind, source_ref);
  `);

  // ── 3. rule_cards — Active rules (palace pointer + counters) ──────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_cards (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id             TEXT    NOT NULL UNIQUE,
      title               TEXT    NOT NULL,
      tier                INTEGER NOT NULL CHECK(tier IN (0,1)),
      source_kind         TEXT    NOT NULL,
      activation_glob     TEXT,
      palace_drawer_id    TEXT,
      body_token_count    INTEGER,
      applied_count       INTEGER NOT NULL DEFAULT 0,
      refuted_count       INTEGER NOT NULL DEFAULT 0,
      last_recalled_at    TEXT,
      last_applied_at     TEXT,
      status              TEXT    NOT NULL DEFAULT 'active'
                            CHECK(status IN ('active','retired','stale')),
      retired_reason      TEXT,
      retired_at          TEXT,
      is_stale            INTEGER NOT NULL DEFAULT 0 CHECK(is_stale IN (0,1)),
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rule_cards_tier_status
      ON rule_cards(tier, status);
    CREATE INDEX IF NOT EXISTS idx_rule_cards_active_glob
      ON rule_cards(activation_glob) WHERE status = 'active';
  `);

  // ── 4. code_diff_outcomes — forward-looking signal (filled by 77c) ────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_diff_outcomes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id         TEXT    NOT NULL,
      pr_url          TEXT,
      decision_id     TEXT,
      outcome         TEXT    NOT NULL CHECK(outcome IN ('accepted','rejected','partial')),
      diff_hash       TEXT,
      observed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      notes           TEXT,
      FOREIGN KEY (rule_id) REFERENCES rule_cards(rule_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_code_diff_outcomes_rule
      ON code_diff_outcomes(rule_id, observed_at);
  `);

  // ── 5. persona_rule_snapshots — durability + replay (BLOCKER-3 fix) ───────
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_rule_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id         TEXT    NOT NULL,
      tier            INTEGER NOT NULL CHECK(tier IN (0,1)),
      title           TEXT    NOT NULL,
      body_yaml       TEXT    NOT NULL,
      source_kind     TEXT    NOT NULL,
      source_ref      TEXT,
      activation_glob TEXT,
      promoted_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      retired_at      TEXT,
      retired_reason  TEXT,
      UNIQUE(rule_id, promoted_at)
    );
    CREATE INDEX IF NOT EXISTS idx_persona_rule_snapshots_active
      ON persona_rule_snapshots(rule_id) WHERE retired_at IS NULL;
  `);

  // ── 6. Ensure persona-extract bucket in model_config (idempotent) ─────────
  // Per ADR-031: every Anthropic call site lives under a named bucket. Persona
  // extraction (77a-03 canonical-prose, 77b clustering) gets its own row.
  // INSERT OR IGNORE keeps this safe to re-run.
  db.exec(`
    INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode, updated_at)
    VALUES ('persona-extract', 'claude-haiku-4-5-20251001', 'low', 'off', datetime('now'));
  `);
}
