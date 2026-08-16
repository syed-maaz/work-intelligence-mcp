/**
 * GAP-003 — Proactive investigation pattern matching on Jira sync.
 *
 * When a new Jira issue lands (CDC INSERT on jira_issues), check whether its
 * title matches a prior completed investigation. If confidence >= threshold,
 * enqueue a proactive_queue notification so the user sees the pattern without
 * manually running /wi-investigate.
 */

import type Database from 'better-sqlite3';
import { findSimilarInvestigation } from '../db/queries/investigation.js';

const PATTERN_MATCH_MIN_CONFIDENCE = 0.7;
const DEDUP_HOURS = 24;

function extractKeywords(title: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'in', 'on', 'at', 'to', 'for',
    'of', 'and', 'or', 'with', 'not', 'it', 'be', 'do', 'does', 'this',
    'that', 'its', 'by', 'from', 'when', 'should', 'will', 'can', 'has',
    'have', 'after', 'before', 'than', 'but', 'also', 'into', 'over',
    'more', 'some', 'such', 'each', 'been', 'their', 'there', 'then',
    'about', 'showing', 'no',
  ]);
  return title
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 6);
}

/**
 * On new Jira issue sync (INSERT only), surface a proactive notification when
 * the title matches a prior investigation above the confidence threshold.
 */
export function maybeNotifyInvestigationPattern(
  db: Database.Database,
  issue: { key: string; title: string },
): void {
  const keywords = extractKeywords(issue.title);
  if (keywords.length === 0) return;

  const prior = findSimilarInvestigation(db, keywords, PATTERN_MATCH_MIN_CONFIDENCE);
  if (!prior) return;

  const dedup = db.prepare(
    `SELECT id FROM proactive_queue
     WHERE agent = 'investigation-pattern' AND source_id = ?
       AND created_at >= datetime('now', '-${DEDUP_HOURS} hours')`,
  ).get(issue.key) as { id: number } | undefined;
  if (dedup) return;

  const owner = prior.owner_team ?? 'unknown';
  const payload = JSON.stringify({
    title: `Pattern match: ${issue.key}`,
    body:
      `New ticket **${issue.key}** matches prior investigation **${prior.issue_key}** ` +
      `(confidence ${prior.confidence.toFixed(2)}).\n\n` +
      `**Past conclusion:** ${prior.conclusion}\n\n` +
      `**Fix owner:** ${owner}`,
    severity: 'attention',
    matched_issue_key: prior.issue_key,
    match_confidence: prior.confidence,
  });

  db.prepare(
    `INSERT INTO proactive_queue (agent, source_id, type, payload)
     VALUES ('investigation-pattern', ?, 'pattern-match', ?)`,
  ).run(issue.key, payload);

  process.stderr.write(
    `[investigation-pattern] ${issue.key} matched ${prior.issue_key} (${prior.confidence})\n`,
  );
}
