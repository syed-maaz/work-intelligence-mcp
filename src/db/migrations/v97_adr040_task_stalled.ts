/**
 * v97 — ADR-040 F-UI (2026-07-10): tasks.stalled flag.
 *
 * Problem: cards whose cypher_session sits at status='pending' with no
 * live dispatch (no dispatch_snapshots row) are zombies — the loop died
 * or the bridge restarted mid-flight and nothing closed the row. Step 3b
 * liberation was recycling them back to `ready`, where a worker re-picked
 * them every ~30-60min forever, spamming "Worker N picked this up"
 * comments (cards #22/#24: ~26 pickups over 18h, session still pending).
 *
 * Fix direction: instead of recycling, flag the card `stalled=1` with a
 * reason, stop re-picking it, and surface a Retrigger affordance in the
 * UI. `stalled` is a flag (like `blocked`/`needs_answer`), not a column —
 * the card keeps its kanban_column so the audit trail is intact.
 *
 * Cleared when: the user Retriggers (fresh dispatch), or the card is
 * manually moved, or a new session on the card reaches a terminal state.
 */

import type Database from 'better-sqlite3';

export default function migrateV97(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'stalled')) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN stalled INTEGER NOT NULL DEFAULT 0 ` +
        `CHECK(stalled IN (0,1))`,
    );
  }
  if (!cols.some((c) => c.name === 'stalled_reason')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN stalled_reason TEXT`);
  }
}
