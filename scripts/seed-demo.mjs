#!/usr/bin/env node
/**
 * STEP 12 (OSS release) — seed the demo database with a wholly-fictional
 * corpus so a zero-connector install still shows a living system:
 *   WI_EMBED_STUB=1 npm run demo
 *
 * Opens the DB at DATABASE_PATH (default ./data/demo.db), runs migrations if
 * the file is fresh, inserts a demo topic FIRST, then messages referencing
 * its id (id/timestamp default; FTS triggers fire automatically — verified
 * against src/db/schema.ts CREATE TABLE IF NOT EXISTS messages: id, topic_id,
 * source, content, author, timestamp, metadata).
 *
 * Idempotent: topics.name is UNIQUE (schema.ts:186) so a 2nd run is a no-op
 * for the topic; messages are appended (plain INSERT — the demo corpus).
 *
 * With ANTHROPIC_API_KEY set, folds in scripts/demo-loop-trace.mjs so the
 * demo leads with the agent loop, not just search.
 */
import { getDatabase } from '../src/db/connection.js';

const DB_PATH = process.env.DATABASE_PATH || './data/demo.db';
const db = getDatabase({ path: DB_PATH });

db.prepare("INSERT OR IGNORE INTO topics (name) VALUES ('demo-topic')").run();
const t = db.prepare("SELECT id FROM topics WHERE name='demo-topic'").get();

const insert = db.prepare(
  'INSERT INTO messages (topic_id, source, content, author) VALUES (?,?,?,?)',
);

// NOTE: source labels use the search-all default sources (email/jira/teams —
// src/tools/search-all.ts:534 filters results by them; 'demo' rows would be
// silently dropped by the post-filter). Data is fictional regardless — the
// WI_DEMO_MODE banner is the guard against mistaking it for real.
const corpus = [
  ['teams', 'PROJ-101 widget rollout on acme/widgets — v2 shipped to 40% of users', 'alex'],
  ['jira', 'PROJ-102 acme/widgets flaky e2e after rollout — flake rate 12%', 'bri'],
  ['email', 'rollback plan for acme/widgets v2 drafted; window Sunday 02:00 UTC', 'cara'],
  ['jira', 'widget dashboard migration tracked in PROJ-103; acme/widgets owners cc-ed', 'alex'],
  ['teams', 'postmortem: PROJ-101 rollout — root cause was cache invalidation, not the widget code', 'bri'],
];
for (const [source, content, author] of corpus) {
  insert.run(t.id, source, content, author);
}

const n = db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
console.log(`[demo] seeded demo-topic with ${corpus.length} fictional messages (${n} total in DB at ${DB_PATH}).`);
console.log('[demo] data is FAKE — run the bridge with WI_DEMO_MODE=1 so the UI shows a "Demo data — not real" banner.');
db.close();

if (process.env.ANTHROPIC_API_KEY) {
  console.log('\n[demo] ANTHROPIC_API_KEY set — running the loop trace:\n');
  const { runDemoTrace } = await import('./demo-loop-trace.mjs');
  await runDemoTrace();
} else {
  console.log('\n[demo] no ANTHROPIC_API_KEY — set it and run `npm run demo:trace` to watch the loop reason over this data.');
}