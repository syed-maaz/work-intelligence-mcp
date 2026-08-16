#!/usr/bin/env node
/**
 * scripts/verifier/evidence-schema-lint-per-commit.mjs
 *
 * ADR-040 §5 verifier-of-verifiers cron #3 — evidence-schema lint.
 * Validates outcome_evidence.raw_payload from the last 7 days against
 * per-tier JSON schemas. Reports pass/fail counts to verifier_health.
 *
 * Threshold: any lint failure marks outcome='fail'.
 * Runs per-commit (via a Husky post-commit or CI hook — wiring is
 * outside the ADR scope; the script itself is invocable standalone).
 */

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = process.env.WI_DB_PATH || join(homedir(), '.work-intelligence-mcp', 'data.db');

function log(...args) { console.log('[evidence-schema-lint-per-commit]', ...args); }

/**
 * Per-tier schemas. Kept inline (rather than in a separate .json) so
 * the cron is self-contained and portable. Additional tier schemas
 * land as the tier ladder gets exercised in later commits.
 */
const TIER_SCHEMAS = {
  // Tier 0 — self_reported (Cypher's own claim). Loosest: goal_text required.
  0: { required: ['goal_text'] },
  // Tier 3 — cross_family_checked. Panel-audit rows need verdict + agents.
  3: { required: ['verdict', 'panel_review_id'] },
  // Tier 5 — smoke_passed. Deterministic smoke run. Needs exit_code.
  5: { required: ['exit_code', 'smoke_section'] },
  // Tier 6-7 — user_observed. Hash + non-fixture id are already enforced
  // by SQL CHECK; here we lint the raw_payload envelope has command +
  // captured_text keys so the audit trail is legible.
  6: { required: ['command', 'captured_text'] },
  7: { required: ['command', 'captured_text'] },
};

function validate(payloadStr, tier) {
  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${String(e).slice(0, 100)}` };
  }
  const schema = TIER_SCHEMAS[tier];
  if (!schema) return { ok: true, reason: 'no schema for tier (skipped)' };
  const missing = (schema.required || []).filter((k) => !(k in payload));
  if (missing.length > 0) {
    return { ok: false, reason: `missing required keys: ${missing.join(', ')}` };
  }
  return { ok: true };
}

const db = new Database(DB_PATH);
const nowMs = Date.now();
const weekAgo = nowMs - 7 * 24 * 3600 * 1000;

const rows = db
  .prepare(
    `SELECT id, tier, raw_payload FROM outcome_evidence WHERE created_at > ? ORDER BY created_at DESC`,
  )
  .all(weekAgo);

log(`linting ${rows.length} rows from last 7d`);

let passed = 0;
let failed = 0;
const failures = [];
for (const row of rows) {
  const v = validate(row.raw_payload, row.tier);
  if (v.ok) {
    passed++;
  } else {
    failed++;
    failures.push({ id: row.id, tier: row.tier, reason: v.reason });
  }
}

const outcome = failed === 0 ? 'pass' : 'fail';
const detail = {
  rows_inspected: rows.length,
  passed,
  failed,
  failures: failures.slice(0, 50), // cap at 50 to keep detail_json manageable
};

db.prepare(
  `INSERT INTO verifier_health(verifier_name, ran_at, outcome, detail_json)
   VALUES ('evidence_schema_lint_per_commit', ?, ?, ?)`,
).run(nowMs, outcome, JSON.stringify(detail));

log(`outcome=${outcome} passed=${passed} failed=${failed}`);
db.close();
process.exit(outcome === 'fail' ? 1 : 0);
