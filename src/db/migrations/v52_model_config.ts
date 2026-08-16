import type Database from 'better-sqlite3';

/**
 * v52 — Tier 2 (T2): per-bucket model + effort configuration.
 *
 * NOTE on slot ownership: Phase 74 (ADR-030 Phase A) drafted a different v52
 * migration in `.planning/phases/74-adr-030-phase-a-self-healing-capture/`
 * but Phase 74 has not shipped to master yet. Tier 2 lands first; Phase 74
 * will renumber its v52 → v53 (or whatever's next at the time it ships).
 * This avoids a gap in the migrations array, which the apply loop would
 * silently skip over.
 *
 * One row per functional bucket. Six buckets are seeded at migration time
 * with evidence-backed defaults (see `src/services/model-config.ts:RECOMMENDED`
 * and `.claude/plans/dapper-plotting-dawn.md` for the per-bucket evidence
 * citations). The user can change any row via `POST /api/model-config` —
 * there is also an admin UI at `/setup/models`.
 *
 * Schema notes:
 *   - `bucket` is PRIMARY KEY so writes use UPSERT semantics.
 *   - `effort` accepts the full Anthropic effort enum: low / medium / high /
 *     xhigh / max. We do NOT enforce a CHECK constraint on (model, effort)
 *     compatibility at the SQL layer because the valid combinations differ
 *     per model (e.g. xhigh is only on Opus 4.7+; max is not on Haiku 4.5).
 *     Validation lives in `src/services/model-config.ts:MODEL_CAPS` and is
 *     enforced by the POST /api/model-config handler — that keeps the
 *     dispatch table in one place rather than duplicating it in SQL.
 *   - `thinking_mode` is 'off' or 'adaptive'. Manual `{type:"enabled",
 *     budget_tokens:N}` is rejected by Opus 4.8 with a 400 error per
 *     https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
 *     so we never expose that mode in the UI or DB.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` pattern, so
 * re-running the migration on a DB that already has the table is a no-op.
 */
export default function migrateV52(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_config (
      bucket TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      thinking_mode TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed evidence-backed defaults. INSERT OR IGNORE so a re-run doesn't
  // clobber a user's manual config (the `bucket` PRIMARY KEY collision
  // path is the no-op).
  const seed = db.prepare(
    `INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode) VALUES (?, ?, ?, ?)`,
  );
  const defaults: Array<[string, string, string, string]> = [
    ['fetch',   'claude-haiku-4-5-20251001', 'low',    'off'],
    ['digest',  'claude-sonnet-4-6',         'medium', 'adaptive'],
    ['chat',    'claude-opus-4-8',           'high',   'adaptive'],
    ['analyse', 'claude-opus-4-8',           'max',    'adaptive'],
    ['decide',  'claude-opus-4-8',           'max',    'adaptive'],
    ['agents',  'claude-haiku-4-5-20251001', 'low',    'off'],
  ];
  for (const row of defaults) seed.run(...row);
}
