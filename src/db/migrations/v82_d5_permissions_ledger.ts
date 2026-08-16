/**
 * v82 — ADR-038 v2.5 D5: permissions ledger (2026-06-26).
 *
 * Closes Gap 20 — the confirm-gate gets memory. Granted permissions
 * persist with explicit scope and lifecycle so the loop can stop
 * asking the same question every dispatch.
 *
 * **Two new tables (additive):**
 *
 * - permissions: the grant ledger. One row per grant the user issues
 *   ('approve this file edit', 'auto-approve smoke runs for this
 *   session', etc.). status tracks lifecycle (active → consumed /
 *   expired / revoked).
 *
 * - permission_uses: append-only audit trail of every consumption.
 *   Keyed on (permission_id, dispatch_id, step_id) so the same grant
 *   can be used many times within different dispatches but each
 *   consumption is uniquely identifiable.
 *
 * **Three-tier risk model lives on tools, not the ledger:**
 * Tools declare risk_tier: 1 | 2 | 3 in ToolDefinition. The ledger
 * itself doesn't gate by tier — that's enforced at the loop's
 * confirm-gate. The ledger is the persistent memory that lets
 * already-granted permissions skip the confirm-gate next time.
 *
 * Crucially: TIER 3 tools (irreversible / colleague-visible)
 * NEVER consult the ledger. They always ask. The ledger entries for
 * tier-3 patterns are rejected at grant time. This is the safety
 * floor — see ADR-038 § D5.
 *
 * **Scope semantics (scope_kind column):**
 *
 *   one_shot    — single use; status flips to 'consumed' after first use
 *   task        — bounded to a task_id (scope_id = tsk_*); status='active'
 *                 until task closes or expires_at hits
 *   project     — bounded to a project slug (scope_id = 'wi', etc.)
 *   session     — bounded to a dispatch session_id (cyp_*)
 *   standing    — no scope; lives forever until revoked
 *
 * **Expiration:** expires_at (timestamp) and expires_after_n (use count
 * cap) are both optional and ANDed when present. The GC daemon (D6)
 * sweeps expired rows nightly.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D5
 *   - src/services/cypher/permissions.ts (runtime accessor)
 *   - src/services/cypher/tool-catalog.ts (risk_tier annotations)
 */

import type Database from 'better-sqlite3';

export default function migrateV82(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS permissions (
      id               TEXT PRIMARY KEY,
      granted_at       INTEGER NOT NULL,
      granted_by       TEXT NOT NULL DEFAULT 'maaz',
      action_pattern   TEXT NOT NULL,
      scope_kind       TEXT NOT NULL CHECK(scope_kind IN
                        ('one_shot','task','project','session','standing')),
      scope_id         TEXT NULL,
      expires_at       INTEGER NULL,
      expires_after_n  INTEGER NULL,
      uses_count       INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'active' CHECK(status IN
                        ('active','expired','revoked','consumed')),
      reason           TEXT NULL,
      revoked_at       INTEGER NULL,
      revoked_reason   TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS permissions_status_idx
      ON permissions(status);
    CREATE INDEX IF NOT EXISTS permissions_pattern_idx
      ON permissions(action_pattern);
    CREATE INDEX IF NOT EXISTS permissions_scope_idx
      ON permissions(scope_kind, scope_id);
    CREATE INDEX IF NOT EXISTS permissions_active_lookup_idx
      ON permissions(status, action_pattern, scope_kind, scope_id);

    CREATE TABLE IF NOT EXISTS permission_uses (
      permission_id  TEXT NOT NULL REFERENCES permissions(id),
      dispatch_id    TEXT NOT NULL,
      step_id        INTEGER NOT NULL,
      used_at        INTEGER NOT NULL,
      PRIMARY KEY (permission_id, dispatch_id, step_id)
    );

    CREATE INDEX IF NOT EXISTS permission_uses_dispatch_idx
      ON permission_uses(dispatch_id);
  `);
}
