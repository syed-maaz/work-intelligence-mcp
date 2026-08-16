/**
 * v95 — ADR-040 F-UI (2026-07-09): card_comments thread + needs_answer flag.
 *
 * Problem this closes: when a Cypher session hits `asked_user` (it needs
 * a clarifying answer), a background dispatch can never answer it, so the
 * card pins its worker forever (the 2026-07-09 "4 workers stuck,
 * ready cards never picked" report). The BoardWorkerAgent now frees such
 * workers after a stale window, but the human never saw *why* the card
 * stalled or had a way to answer.
 *
 * This migration adds:
 *   - `card_comments` — an activity + Q&A thread per card. The worker/
 *     session writes `progress` and `question` entries; the user writes
 *     `answer` / `note` entries. This is the card's "what has been done
 *     so far" surface.
 *   - `tasks.needs_answer` — a flag set when a `question` comment is
 *     open (unanswered). The board renders a distinct badge + colour for
 *     needs_answer=1 cards so they stand out from normal in-flight work.
 *
 * author enum: 'worker' | 'cypher' | 'user' | 'system'
 * kind enum:   'progress' | 'question' | 'answer' | 'note'
 */

import type Database from 'better-sqlite3';

export default function migrateV95(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_comments (
      id          TEXT    PRIMARY KEY,
      task_id     TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author      TEXT    NOT NULL DEFAULT 'system'
                  CHECK(author IN ('worker','cypher','user','system')),
      kind        TEXT    NOT NULL DEFAULT 'note'
                  CHECK(kind IN ('progress','question','answer','note')),
      body        TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS card_comments_task_idx ` +
      `ON card_comments(task_id, created_at ASC)`,
  );

  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'needs_answer')) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN needs_answer INTEGER NOT NULL DEFAULT 0 ` +
        `CHECK(needs_answer IN (0,1))`,
    );
  }
}
