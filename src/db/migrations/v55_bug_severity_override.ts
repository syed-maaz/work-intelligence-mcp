/**
 * v55 — Manual severity override for bugs.
 *
 * Three additive columns on `bugs`:
 *   1. `severity_override TEXT` — when non-null, takes precedence over the
 *      ring-buffer-computed severity. CHECK enum mirrors `severity` so a
 *      user can only override to a valid severity value.
 *   2. `severity_override_reason TEXT` — free-form note explaining why the
 *      bug was escalated. Surfaced in the UI so future readers understand
 *      the escalation context.
 *   3. `severity_override_at TEXT` — ISO-8601 timestamp recording when the
 *      override was set. Lets the UI render "manually escalated <relative
 *      time>". Cleared back to NULL when the override is removed.
 *
 * Why a separate column instead of overwriting `severity`? The scope fence
 * in src/routes/bugs.ts is explicit: severity must NEVER be derived from
 * `occurrence_count + last_seen_at`; it's always recomputed from the
 * `bug_occurrences` ring buffer. Storing manual overrides in their own
 * column preserves that invariant — `computeSeverity()` returns
 * `severity_override` if present, otherwise the ring-buffer result.
 *
 * The display severity (`bugs.severity`) is now: COALESCE(override, computed).
 * Lists, filters, and the system-health rollup all keep working without
 * code change because they read `bugs.severity` which is updated to
 * COALESCE on every write.
 *
 * Idempotent: ALTER TABLE ADD COLUMN is non-idempotent in SQLite, so we
 * guard via PRAGMA table_info before each ADD.
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md § Phase B
 *       (escalation is an additive UX layer on top of Phase B's substrate)
 */
import Database from 'better-sqlite3';

export default function migrateV55(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(bugs)`).all() as Array<{ name: string }>;
  const has = (name: string) => cols.some(c => c.name === name);

  if (!has('severity_override')) {
    db.exec(
      `ALTER TABLE bugs ADD COLUMN severity_override TEXT
         CHECK (severity_override IS NULL OR severity_override IN ('low','medium','high'))`,
    );
  }
  if (!has('severity_override_reason')) {
    db.exec(`ALTER TABLE bugs ADD COLUMN severity_override_reason TEXT`);
  }
  if (!has('severity_override_at')) {
    db.exec(`ALTER TABLE bugs ADD COLUMN severity_override_at TEXT`);
  }
}
