import Database from 'better-sqlite3';

export default function migrateV50(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      notes       TEXT,
      due_at      TEXT    NOT NULL,
      recurrence  TEXT,
      channel     TEXT    NOT NULL DEFAULT 'apple',
      priority    TEXT    NOT NULL DEFAULT 'medium',
      status      TEXT    NOT NULL DEFAULT 'pending',
      apple_id    TEXT,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      snoozed_until TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_due   ON reminders(due_at)   WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
  `);
}
