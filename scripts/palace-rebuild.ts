#!/usr/bin/env tsx
/**
 * palace-rebuild — Replay all SQLite data into MemPalace.
 * Usage: npm run palace:rebuild
 *
 * Rebuilds palace from scratch using:
 * 1. Feature flags from operations repo
 * 2. Topic notebooks
 * 3. Recent Jira transitions (last 90 days)
 * 4. Conversation summaries (last 30 days)
 * 5. Meeting transcripts (last 30 days)
 * 6. Recent messages for entity extraction (last 7 days)
 * 7. Investigation payloads (investigation_sessions.palace_payload)
 *
 * Requires: MEMPALACE_PATH and DATABASE_PATH env vars
 */

import { getDatabase } from '../src/db/connection.js';
import { PalaceClient } from '../src/intelligence/palace-client.js';
import { MemoryEnricher } from '../src/intelligence/memory-enricher.js';
import { runPalaceSeeder } from '../src/intelligence/palace-seeder.js';

async function main() {
  const palacePath = process.env.MEMPALACE_PATH;
  if (!palacePath) {
    console.error('MEMPALACE_PATH not set');
    process.exit(1);
  }

  const db = getDatabase();
  const palace = new PalaceClient(palacePath);
  const enricher = new MemoryEnricher(palace);

  console.log('[palace-rebuild] Starting full rebuild...');

  try {
  // 1. Feature flags from operations repo
  try {
    const result = await runPalaceSeeder(palacePath, './repos/operations', palace);
    console.log(`[palace-rebuild] Seeder: ${result.flagsProcessed} flags, ${result.triplesWritten} triples`);
  } catch (err) {
    console.error(`[palace-rebuild] Seeder failed: ${(err as Error).message}`);
  }

  // 2. All topic notebooks
  const notebooks = db.prepare('SELECT topic_name AS name, content FROM topic_notebooks WHERE content IS NOT NULL').all();

  // 3. Jira transitions (last 90 days)
  const transitions = db.prepare(
    `SELECT issue_key, from_status, to_status, transitioned_at
     FROM jira_transitions WHERE transitioned_at > datetime('now', '-90 days')`
  ).all();

  // 4. Conversations (last 30 days)
  const conversations = db.prepare(
    `SELECT name AS chatSlug, name AS summary
     FROM group_chats WHERE last_message_at > datetime('now', '-30 days')`
  ).all().map((r: any) => ({
    chatSlug: r.chatSlug,
    summary: r.summary || '',
    participants: [] as string[],
    topicName: null,
  }));

  // 5. Meetings with transcripts (last 30 days)
  const meetings = db.prepare(
    `SELECT id, chat_name AS meetingSlug, title, transcript, date
     FROM meetings WHERE transcript IS NOT NULL AND length(transcript) > 100
       AND date > datetime('now', '-30 days')`
  ).all().map((r: any) => ({
    meetingSlug: r.meetingSlug || `meeting-${r.id}`,
    title: r.title || '',
    transcript: r.transcript,
    decisions: [],
    date: r.date,
  }));

  // 6. Recent messages for entity extraction
  const messages = db.prepare(
    `SELECT content, author, subject, source FROM messages
     WHERE timestamp > datetime('now', '-7 days') ORDER BY timestamp DESC LIMIT 500`
  ).all();

  const enrichResult = await enricher.enrichFromSync({
    topicNotebooks: notebooks as any,
    jiraTransitions: transitions as any,
    conversations,
    meetings,
    messages: messages as any,
  });

  console.log(`[palace-rebuild] Enrichment: ${enrichResult.drawersWritten} drawers, ${enrichResult.triplesWritten} triples, ${enrichResult.entitiesExtracted} entities`);

  // 7. Replay investigation payloads (if palace_payload column exists — schema v37)
  try {
    const payloads = db.prepare(
      `SELECT issue_key, palace_payload FROM investigation_sessions WHERE palace_payload IS NOT NULL`
    ).all();
    for (const row of payloads as any[]) {
      try {
        const payload = JSON.parse(row.palace_payload);
        if (payload.drawerContent) {
          await palace.addDrawer('investigations', payload.room || 'unknown', payload.drawerContent, row.issue_key);
        }
      } catch { /* skip malformed payloads */ }
    }
    console.log(`[palace-rebuild] Replayed ${(payloads as any[]).length} investigation payloads`);
  } catch {
    console.log('[palace-rebuild] No palace_payload column yet (schema < v37) — skipping investigation replay');
  }

  } finally {
    await palace.shutdown();
  }

  console.log('[palace-rebuild] Done.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
