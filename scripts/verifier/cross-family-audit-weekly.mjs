#!/usr/bin/env node
/**
 * scripts/verifier/cross-family-audit-weekly.mjs
 *
 * ADR-040 §5 verifier-of-verifiers cron #2 — cross-family audit.
 * Samples 10 recent outcome_evidence rows and asks a non-Anthropic
 * model (GPT-4o-mini by default) whether the raw_payload's verdict
 * matches the goal claim. Logs disagreement rate to verifier_health.
 *
 * Fail-open per §6.3: if OPENAI_API_KEY is unset, records
 * outcome='error' with a note and exits 0 — the cron ran, the audit
 * couldn't. That keeps AC-S13 verifiable (row exists) while making
 * the missing-key case visible.
 *
 * Threshold: disagreement > 20% marks outcome='fail'.
 * Runs weekly.
 */

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = process.env.WI_DB_PATH || join(homedir(), '.work-intelligence-mcp', 'data.db');
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.CROSS_FAMILY_AUDIT_MODEL || 'gpt-4o-mini';
const SAMPLE_SIZE = 10;
const DISAGREEMENT_THRESHOLD = 0.2;

function log(...args) { console.log('[cross-family-audit-weekly]', ...args); }

const db = new Database(DB_PATH);
const nowMs = Date.now();
const weekAgo = nowMs - 7 * 24 * 3600 * 1000;

const sample = db
  .prepare(
    `SELECT id, session_id, tier, verified_via, verdict, raw_payload
       FROM outcome_evidence
      WHERE created_at > ?
      ORDER BY random()
      LIMIT ?`,
  )
  .all(weekAgo, SAMPLE_SIZE);

log(`sampled ${sample.length} rows from last 7d`);

// Fail-open path: no key → write error row and exit clean.
if (!OPENAI_KEY) {
  db.prepare(
    `INSERT INTO verifier_health(verifier_name, ran_at, outcome, detail_json)
     VALUES ('cross_family_audit_weekly', ?, 'error', ?)`,
  ).run(
    nowMs,
    JSON.stringify({
      note: 'OPENAI_API_KEY unset — cross-family audit skipped per §6.3 fail-open',
      samples_available: sample.length,
    }),
  );
  log('OPENAI_API_KEY not set — recorded error row and exiting');
  db.close();
  process.exit(0);
}

// With samples in hand, submit each to the non-Anthropic model.
let disagreements = 0;
let apiErrors = 0;
const results = [];

for (const row of sample) {
  try {
    const prompt =
      `You are auditing a delivery-outcome record. Row:\n\n` +
      `  tier: ${row.tier}\n` +
      `  verified_via: ${row.verified_via}\n` +
      `  verdict: ${row.verdict}\n` +
      `  raw_payload (truncated 500 chars): ${String(row.raw_payload).slice(0, 500)}\n\n` +
      `Given the payload, does verdict='${row.verdict}' honestly describe what the payload shows? ` +
      `Reply with a single word: YES or NO.`;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8,
        temperature: 0,
      }),
    });

    if (!resp.ok) {
      apiErrors++;
      results.push({ id: row.id, error: `HTTP ${resp.status}` });
      continue;
    }
    const data = await resp.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toUpperCase() ?? '';
    const agreed = answer.startsWith('YES');
    if (!agreed) disagreements++;
    results.push({ id: row.id, agreed, answer });
  } catch (err) {
    apiErrors++;
    results.push({ id: row.id, error: String(err).slice(0, 200) });
  }
}

const successfullyAudited = sample.length - apiErrors;
const disagreementRate = successfullyAudited > 0 ? disagreements / successfullyAudited : 0;
const outcome =
  apiErrors === sample.length
    ? 'error'
    : disagreementRate > DISAGREEMENT_THRESHOLD
      ? 'fail'
      : successfullyAudited < sample.length
        ? 'flaky'
        : 'pass';

const detail = {
  model: OPENAI_MODEL,
  sample_size: sample.length,
  successfully_audited: successfullyAudited,
  disagreements,
  disagreement_rate: Number(disagreementRate.toFixed(3)),
  api_errors: apiErrors,
  per_row: results,
};

db.prepare(
  `INSERT INTO verifier_health(verifier_name, ran_at, outcome, detail_json)
   VALUES ('cross_family_audit_weekly', ?, ?, ?)`,
).run(nowMs, outcome, JSON.stringify(detail));

log(`outcome=${outcome} disagreement_rate=${disagreementRate.toFixed(3)} (${disagreements}/${successfullyAudited})`);
db.close();
process.exit(0);
