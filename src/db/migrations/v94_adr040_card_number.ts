/**
 * v94 — ADR-040 F-UI (2026-07-09): human-readable card_number on tasks.
 *
 * Cards were referenced only by opaque ids (`task_ae7e3a6f0003`). Maaz
 * asked for a short number to refer to a card ("#42"). This adds a
 * sequential `card_number INTEGER` and backfills existing rows in
 * `created_at` order so the oldest card is #1.
 *
 * Assignment going forward: the /wi dispatch + cypher_task_create paths
 * set card_number = (SELECT COALESCE(MAX(card_number),0)+1 FROM tasks)
 * at INSERT. It's not a strict AUTOINCREMENT column because tasks.id is
 * already the TEXT PK; card_number is a display-only secondary sequence.
 *
 * Nullable (no NOT NULL) so any INSERT path that forgets to set it
 * doesn't crash — the UI falls back to showing the short id suffix when
 * card_number is null. Backfill covers everything that exists at
 * migration time.
 */

import type Database from 'better-sqlite3';

export default function migrateV94(db: Database.Database): void {
  // Add the column (nullable — backfill fills existing rows).
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'card_number')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN card_number INTEGER`);
  }

  // Backfill in created_at order so the oldest card is #1. Deterministic
  // and idempotent: only fills rows where card_number IS NULL.
  const rows = db
    .prepare(`SELECT id FROM tasks WHERE card_number IS NULL ORDER BY created_at ASC, id ASC`)
    .all() as { id: string }[];
  const startAt =
    (db.prepare(`SELECT COALESCE(MAX(card_number), 0) AS m FROM tasks`).get() as { m: number }).m;
  const upd = db.prepare(`UPDATE tasks SET card_number = ? WHERE id = ?`);
  const txn = db.transaction(() => {
    let n = startAt;
    for (const r of rows) {
      n += 1;
      upd.run(n, r.id);
    }
  });
  txn();

  db.exec(`CREATE INDEX IF NOT EXISTS tasks_card_number_idx ON tasks(card_number)`);
}
