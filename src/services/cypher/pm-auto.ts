/**
 * PM-AUTO (slice 81a, 2026-06-14): autonomous PM writes.
 *
 * PM-4 (commit 197c5c1) added regex-based AC-id extraction in
 * `auto-link.ts` and surfaced the matches in the dispatch response —
 * but it never persisted them. PM-AUTO closes that gap by writing the
 * high-confidence subset directly, plus auto-detecting commits at
 * outcome time and auto-flipping work_item status.
 *
 * Two pure functions, both Hard-rule-7 compliant (read/write
 * work_items + work_item_links via the PM lens helpers in pm.ts):
 *
 *   - autoLinkOnDispatch  — called from run.ts after PM-4 suggestion
 *                           is computed. Writes (work_item_id,
 *                           cypher_session_id, session_id) for every
 *                           confidence===1.0 + exists suggestion.
 *                           If the work_item was 'pending', also
 *                           transitions to 'in_progress'.
 *
 *   - autoCloseOnOutcome  — called from run.ts when input.outcome is
 *                           supplied. On 'success' AND the current
 *                           branch is NOT main/master, scans git log
 *                           for commits between session.started_at
 *                           and now, and links each as commit_sha
 *                           evidence to every work_item already
 *                           linked to this session. If the work_item
 *                           was 'in_progress', transitions to 'shipped'.
 *
 * Every autonomous write logs a row to pm_auto_actions (schema v61).
 * The audit table is the contract: panel section C reads it; smoke
 * tests assert specific (action, reason) shapes against it.
 *
 * Confidence gate (auto-link):
 *   - confidence === 1.0  ⇒ auto-write (PERSONA-AC-N, PM-N, PHASE-NN-*,
 *                            CYPHER-*). These ids match the work_items
 *                            namespace exactly.
 *   - confidence  <  1.0  ⇒ suggest-only (e.g. bare Jira ticket numbers). False-
 *                            positive risk: a goal mentions JIRA-15702
 *                            for context, not because the work targets
 *                            it. Stays in the dispatch response but
 *                            never writes.
 *
 * Branch safety (auto-close):
 *   - main/master never auto-link commits. Shared branches can carry
 *     unrelated work; only feature branches get auto-attribution.
 *   - The scan window is [session.started_at, now]. If the user
 *     committed concurrent work the auto-link will catch it; the
 *     correction path is the existing /api/cypher/pm/link, not a
 *     special "remove" call.
 */

import type Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { getWorkItem, linkEvidence, setStatus } from './pm.js';
import type { AutoLinkSuggestion } from './auto-link.js';

export type AutoAction =
  | 'link_session'
  | 'link_commit'
  | 'transition_in_progress'
  | 'transition_shipped';

export interface AutoActionRow {
  id: number;
  session_id: string;
  work_item_id: string;
  action: AutoAction;
  evidence_kind: string | null;
  evidence_value: string | null;
  reason: string;
  created_at: string;
}

interface RecordParams {
  session_id: string;
  work_item_id: string;
  action: AutoAction;
  evidence_kind?: string | null;
  evidence_value?: string | null;
  reason: string;
}

function recordAutoAction(db: Database.Database, p: RecordParams): void {
  db.prepare(`
    INSERT INTO pm_auto_actions (session_id, work_item_id, action, evidence_kind, evidence_value, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    p.session_id,
    p.work_item_id,
    p.action,
    p.evidence_kind ?? null,
    p.evidence_value ?? null,
    p.reason,
  );
}

export interface AutoLinkResult {
  /** Work-item ids that were auto-linked to this session. */
  linked: string[];
  /** Work-item ids that were also auto-transitioned pending → in_progress. */
  transitioned: string[];
  /** Suggestions skipped (confidence < 1.0 or work_item missing). */
  skipped: number;
}

/**
 * Auto-link every confidence===1.0 + exists suggestion to the session.
 * Idempotent (linkEvidence is INSERT OR IGNORE; status flip checks
 * current value first).
 */
export function autoLinkOnDispatch(
  db: Database.Database,
  session_id: string,
  suggestions: AutoLinkSuggestion[],
): AutoLinkResult {
  const linked: string[] = [];
  const transitioned: string[] = [];
  let skipped = 0;

  for (const s of suggestions) {
    if (s.confidence < 1.0 || !s.exists) {
      skipped += 1;
      continue;
    }
    const wi = getWorkItem(db, s.id);
    if (!wi) {
      skipped += 1;
      continue;
    }
    linkEvidence(db, s.id, 'cypher_session_id', session_id, 'auto-linked by PM-AUTO');
    recordAutoAction(db, {
      session_id,
      work_item_id: s.id,
      action: 'link_session',
      evidence_kind: 'cypher_session_id',
      evidence_value: session_id,
      reason: 'pm4_high_confidence',
    });
    linked.push(s.id);

    if (wi.status === 'pending') {
      setStatus(db, s.id, 'in_progress');
      recordAutoAction(db, {
        session_id,
        work_item_id: s.id,
        action: 'transition_in_progress',
        reason: 'first_link',
      });
      transitioned.push(s.id);
    }
  }

  return { linked, transitioned, skipped };
}

export interface AutoCloseResult {
  /** Commit SHAs written as evidence (one row per (work_item × commit)). */
  commits_linked: number;
  /** Work-item ids transitioned in_progress → shipped. */
  shipped: string[];
  /** Reason this auto-close was a no-op, if it was. */
  skipped_reason?: 'not_success' | 'protected_branch' | 'no_commits' | 'no_linked_items';
}

function currentBranch(): string | null {
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function commitsSince(since: string): string[] {
  try {
    const out = execSync(`git log --since="${since} UTC" --pretty=format:%H HEAD`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

interface AutoCloseInput {
  session_id: string;
  outcome: 'success' | 'mixed' | 'failed';
  /** session.started_at, ISO-ish string from SQLite. */
  started_at: string;
  /** Optional override for tests. When omitted, calls git directly. */
  branchOverride?: string;
  /** Optional override for tests. When omitted, calls git directly. */
  commitsOverride?: string[];
}

/**
 * Auto-close: scan commits since session.started_at on the current
 * branch (unless main/master), link each to every work_item already
 * linked to this session, and transition in_progress → shipped.
 *
 * Only fires on outcome='success'. mixed/failed leave the work
 * mid-flight; flipping to shipped on partial success would be a lie.
 */
export function autoCloseOnOutcome(
  db: Database.Database,
  input: AutoCloseInput,
): AutoCloseResult {
  if (input.outcome !== 'success') {
    return { commits_linked: 0, shipped: [], skipped_reason: 'not_success' };
  }

  const branch = input.branchOverride ?? currentBranch();
  if (branch === 'main' || branch === 'master') {
    return { commits_linked: 0, shipped: [], skipped_reason: 'protected_branch' };
  }

  const linkedItems = db.prepare<[string], { work_item_id: string }>(`
    SELECT DISTINCT work_item_id FROM work_item_links
     WHERE evidence_kind = 'cypher_session_id' AND evidence_value = ?
  `).all(input.session_id);

  if (linkedItems.length === 0) {
    return { commits_linked: 0, shipped: [], skipped_reason: 'no_linked_items' };
  }

  const commits = input.commitsOverride ?? commitsSince(input.started_at);
  if (commits.length === 0) {
    return { commits_linked: 0, shipped: [], skipped_reason: 'no_commits' };
  }

  const reason = `branch=${branch ?? 'unknown'}`;
  let commits_linked = 0;
  const shipped: string[] = [];

  for (const row of linkedItems) {
    const wiId = row.work_item_id;
    const wi = getWorkItem(db, wiId);
    if (!wi) continue;

    for (const sha of commits) {
      linkEvidence(db, wiId, 'commit_sha', sha, 'auto-linked by PM-AUTO');
      recordAutoAction(db, {
        session_id: input.session_id,
        work_item_id: wiId,
        action: 'link_commit',
        evidence_kind: 'commit_sha',
        evidence_value: sha,
        reason,
      });
      commits_linked += 1;
    }

    if (wi.status === 'in_progress') {
      setStatus(db, wiId, 'shipped');
      recordAutoAction(db, {
        session_id: input.session_id,
        work_item_id: wiId,
        action: 'transition_shipped',
        reason: 'commit_linked',
      });
      shipped.push(wiId);
    }
  }

  return { commits_linked, shipped };
}

/**
 * Read helper for slice 81b — last N auto-actions across all sessions.
 */
export function recentAutoActions(db: Database.Database, limit: number = 50): AutoActionRow[] {
  return db.prepare<[number], AutoActionRow>(`
    SELECT id, session_id, work_item_id, action, evidence_kind, evidence_value, reason, created_at
      FROM pm_auto_actions
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(limit);
}
