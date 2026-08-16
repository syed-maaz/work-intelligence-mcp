import type Database from 'better-sqlite3';

/**
 * v95→v96: register the `dispatch` model_config bucket.
 *
 * The Cypher loop controller previously always resolved its model from the
 * `decide` bucket (Opus/max) regardless of task_class — so routine /wi goals
 * (fetch a PR, summarize a thread, look something up) paid Opus/max latency
 * per iteration. The loop now routes fetch/summarize/review task_classes to
 * this Sonnet-backed `dispatch` bucket via pickControllerBucket() in
 * src/services/cypher/loop.ts; design/debug/plan/write/unknown stay on `decide`.
 *
 * Idempotent: INSERT OR IGNORE so a manual override via /setup/models (or a
 * re-run) is never clobbered. Mirrors the persona-extract seed in v58.
 */
export default function migrateV96(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode, updated_at)
     VALUES ('dispatch', 'claude-sonnet-4-6', 'medium', 'off', datetime('now'))`,
  ).run();
}
