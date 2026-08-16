// Schema v46 — ADR-025 §Schema migration v46
// Adds nullable `bucket TEXT DEFAULT 'brain'` column to brain_user_budget_ledger,
// creates composite UNIQUE index (user, day_iso, bucket) for isolated budget tracking,
// and backfills pre-existing rows to bucket='brain'.
// Idempotent: ALTER is caught if column already exists; index uses IF NOT EXISTS.
import type Database from 'better-sqlite3';

export default function up(db: Database.Database): void {
  db.transaction(() => {
    // Step 1: Add column (idempotent — catch "duplicate column name")
    try {
      db.exec(`ALTER TABLE brain_user_budget_ledger ADD COLUMN bucket TEXT DEFAULT 'brain'`);
    } catch (err: unknown) {
      if (!(err instanceof Error) || !err.message.includes('duplicate column name')) throw err;
    }
    // Step 2: Backfill pre-existing rows (pre-v46 rows all belong to the brain bucket)
    db.exec(`UPDATE brain_user_budget_ledger SET bucket = 'brain' WHERE bucket IS NULL`);
    // Step 3: Create composite UNIQUE index AFTER backfill (avoids unique constraint violation on NULL rows)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_budget_user_day_bucket ON brain_user_budget_ledger(user, day_iso, bucket)`);
  })();
}

export function down(db: Database.Database): void {
  // SQLite cannot reliably DROP COLUMN without table rebuild; drop only the index.
  db.exec(`DROP INDEX IF EXISTS idx_brain_budget_user_day_bucket`);
}
