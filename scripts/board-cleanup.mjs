#!/usr/bin/env node
/**
 * Board hygiene cleanup (2026-07-15) — one-shot, dry-run by default.
 *
 * The /board Kanban accumulated ~70% smoke/test pollution: every
 * POST /api/wi/dispatch auto-seeded a `ready` card, and smoke-bridge.sh
 * fires dozens of `task_class:"smoke"` dispatches (goals like "smoke § 20.2").
 * The BoardWorkerAgent deliberately skips those (board-worker-agent.ts:453-457),
 * so they sit in `ready` forever. Separately, cards reaching kanban_column='done'
 * keep status='open' (status and kanban_column are independent columns), leaving
 * a done-but-open contradiction.
 *
 * This script:
 *   1. PURGE — delete open smoke cards (title/id/project patterns mirroring the
 *      BoardWorkerAgent skip filter, so we delete exactly what the board ignores).
 *   2. RECONCILE — close cards in kanban_column='done' that are still status='open'.
 *   3. REPORT — list remaining real cards stuck in `ready` (do NOT auto-touch).
 *
 * DRY-RUN by default (prints, changes nothing). Pass --apply to mutate.
 * Run under node 24 (better-sqlite3 ABI):
 *   PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH" node scripts/board-cleanup.mjs [--apply]
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.DATABASE_PATH || path.join(os.homedir(), '.work-intelligence-mcp', 'data.db');
const db = new Database(DB_PATH);

// Smoke-card predicate — mirrors BoardWorkerAgent's skip filter
// (board-worker-agent.ts:453-457) plus the observed pollution titles, so the
// purge deletes exactly the cards the board already refuses to work.
// ALL statuses (closed smoke cards still render on /board). Anchored patterns
// (title STARTS WITH a smoke marker) + explicit exclusions so real dev tasks
// that merely mention "smoke"/"SCOPE"/"§" (e.g. "add a smoke section…",
// "Board hygiene: gate smoke dispatches", "fix SCOPE wall-clock") are KEPT.
const SMOKE_WHERE = `
  (
    project = 'smoke-test-d3s3'
    OR title LIKE 'Smoke test task%'
    OR title LIKE 'smoke §%'
    OR title LIKE 'smoke 3%'
    OR title LIKE 'smoke debug%'
    OR title LIKE 'smoke recheck%'
    OR title LIKE 'adr040-c1-smoke-%'
    OR title LIKE '§30 recurate probe%'
    OR title LIKE '§%'
    OR title LIKE 'backpressure cleared probe%'
    OR title LIKE '%backcompat fixture%'
    OR title LIKE 'adr040 activity comment test card%'
    OR (external_ref IS NOT NULL AND external_ref LIKE 'smoke%')
  )
  AND title NOT LIKE 'add a smoke section%'
  AND title NOT LIKE 'Board hygiene%'
  AND title NOT LIKE 'fix SCOPE%'
  AND title NOT LIKE 'SCOPE catalog fix%'
  AND title NOT LIKE 'Tag 8 execute%'`;

console.log(`\n=== Board cleanup (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${DB_PATH} ===\n`);

// 1. PURGE candidates
const purge = db.prepare(
  `SELECT id, card_number, kanban_column, substr(title,1,55) AS t, project FROM tasks WHERE ${SMOKE_WHERE} ORDER BY created_at`,
).all();
console.log(`--- 1. PURGE: ${purge.length} smoke cards to delete ---`);
for (const r of purge) console.log(`   [${r.kanban_column}] #${r.card_number ?? '-'} ${r.t}  (${r.project})`);

// 2. RECONCILE candidates (done column, still open, and NOT a smoke card being purged)
const reconcile = db.prepare(
  `SELECT id, substr(title,1,55) AS t FROM tasks
   WHERE kanban_column = 'done' AND status = 'open' AND NOT (${SMOKE_WHERE})`,
).all();
console.log(`\n--- 2. RECONCILE: ${reconcile.length} done-but-open cards to close ---`);
for (const r of reconcile) console.log(`   ${r.t}`);

// 3. REPORT real cards still stuck in ready (after purge) — triage, don't touch
const stuckReady = db.prepare(
  `SELECT substr(title,1,55) AS t, ROUND((julianday('now')-julianday(datetime(created_at/1000,'unixepoch')))) AS age_d
   FROM tasks WHERE status='open' AND kanban_column='ready' AND NOT (${SMOKE_WHERE}) ORDER BY created_at`,
).all();
console.log(`\n--- 3. REPORT: ${stuckReady.length} REAL cards stuck in 'ready' (triage manually) ---`);
for (const r of stuckReady) console.log(`   (${r.age_d}d) ${r.t}`);

if (!APPLY) {
  console.log(`\nDRY-RUN complete. Re-run with --apply to delete ${purge.length} and close ${reconcile.length}.\n`);
  process.exit(0);
}

const tx = db.transaction(() => {
  // Clear FK references to the doomed cards first — cypher_sessions.task_id,
  // task_history.task_id, task_contexts.task_id reference tasks(id) WITHOUT
  // ON DELETE CASCADE, so the DELETE fails otherwise. (panel_reviews etc. DO
  // cascade.) Only smoke cards (all in `ready`, none worker-assigned) are hit.
  const doomed = db.prepare(`SELECT id FROM tasks WHERE ${SMOKE_WHERE}`).all().map((r) => r.id);
  const clearRefs = db.transaction(() => {
    const nullSess = db.prepare(`UPDATE cypher_sessions SET task_id = NULL WHERE task_id = ?`);
    const delHist = db.prepare(`DELETE FROM task_history WHERE task_id = ?`);
    const delCtx = db.prepare(`DELETE FROM task_contexts WHERE task_id = ?`);
    const nullWorker = db.prepare(`UPDATE workers SET current_task_id = NULL WHERE current_task_id = ?`);
    for (const id of doomed) { nullSess.run(id); delHist.run(id); delCtx.run(id); nullWorker.run(id); }
  });
  clearRefs();
  const del = db.prepare(`DELETE FROM tasks WHERE ${SMOKE_WHERE}`).run();
  const upd = db.prepare(
    `UPDATE tasks SET status='closed', closed_at=datetime('now'),
       closed_reason='board-hygiene: done-column reconcile 2026-07-15'
     WHERE kanban_column='done' AND status='open'`,
  ).run();
  return { deleted: del.changes, closed: upd.changes };
});
const res = tx();
console.log(`\nAPPLIED: deleted ${res.deleted} smoke cards, closed ${res.closed} done-but-open cards.\n`);
db.close();
