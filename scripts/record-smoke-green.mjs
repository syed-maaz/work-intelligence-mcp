#!/usr/bin/env node
/**
 * scripts/record-smoke-green.mjs
 *
 * ADR-040 follow-up 2026-07-13 — smoke freshness gate (D1 quick shape).
 *
 * Records `smoke_bridge_last_green = Date.now()` into schema_metadata after
 * a successful `smoke:bridge` run. BoardWorkerAgent reads this key before
 * advancing `in_progress → review` when BOARD_SMOKE_GATE_ENABLED=1.
 *
 * This is the FRESHNESS-GATED shape (audit §4 shape 2), NOT the per-card
 * smoke shape (§4 shape 1). It gives a weaker guarantee: catches "smoke
 * hasn't been run for N hours" but doesn't catch "smoke wasn't run since
 * this specific card's changes." That trade-off is deliberate — solo-dev
 * cadence, and the DoD is already holding via the human click at e2e→done.
 *
 * # Usage
 *
 *   npm run smoke:bridge && node scripts/record-smoke-green.mjs
 *
 * Or wire into your smoke:bridge chain via npm's `&&` operator:
 *
 *   "smoke:bridge:record": "bash scripts/smoke-bridge.sh && node scripts/record-smoke-green.mjs"
 *
 * # Exit codes
 *
 *   0 — recorded successfully (schema_metadata upserted)
 *   1 — DB error or schema_metadata missing
 *
 * # Idempotency
 *
 * Upsert via INSERT OR REPLACE. Running twice in a row records two identical
 * (or newer) timestamps; no state accumulates.
 */

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = process.env.WI_DB_PATH || join(homedir(), '.work-intelligence-mcp', 'data.db');
const KEY = 'smoke_bridge_last_green';

function log(...args) { console.log('[record-smoke-green]', ...args); }

let db;
try {
  db = new Database(DB_PATH);
} catch (err) {
  console.error(`[record-smoke-green] cannot open DB at ${DB_PATH}: ${err.message}`);
  process.exit(1);
}

try {
  // schema_metadata exists from v0 — no CREATE IF NOT EXISTS needed. If it's
  // missing (fresh dev DB), fail loud rather than silently no-op.
  const check = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_metadata'`,
  ).get();
  if (!check) {
    console.error('[record-smoke-green] schema_metadata table missing — did migrations run?');
    process.exit(1);
  }
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO schema_metadata(key, value) VALUES (?, ?)`,
  ).run(KEY, String(now));
  log(`recorded ${KEY} = ${now} (${new Date(now).toISOString()})`);
  process.exit(0);
} catch (err) {
  console.error(`[record-smoke-green] upsert failed: ${err.message}`);
  process.exit(1);
} finally {
  db.close();
}
