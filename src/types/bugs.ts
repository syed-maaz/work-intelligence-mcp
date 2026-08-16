/**
 * Types for ADR-030 Phase A — Self-Healing Bug Loop.
 *
 * Mirrors the SQL schema in src/db/migrations/v53_bug_capture_tables.ts.
 * Source of truth for the schema is the migration; these types are derived.
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md
 */

import type { RecallSource } from '../services/brain/recall.js';

export type BugSource = 'bridge' | 'agent' | 'web-ui' | 'sync' | 'bug-investigator';
/**
 * Status enum. Phase A seeded `'new' | 'investigating' | 'proposed' | 'auto-merged' | 'resolved' | 'wont-fix'`.
 * Phase 76 (v56) widens with three resolver-flow states:
 *   - `'resolving'` — set when POST /api/bugs/:id/resolve-attempt enqueues
 *     the agent. Agent picks up the row from this state.
 *   - `'auto-resolved'` — terminal success: patch applied + typecheck clean
 *     + commit landed locally (never pushed).
 *   - `'unable-to-resolve'` — terminal failure: any pre-flight or apply
 *     gate failed. Reason recorded in `bug_resolutions.failure_reason`.
 */
export type BugStatus =
  | 'new'
  | 'investigating'
  | 'proposed'
  | 'auto-merged'
  | 'resolved'
  | 'wont-fix'
  | 'resolving'
  | 'auto-resolved'
  | 'unable-to-resolve';
export type BugSeverity = 'low' | 'medium' | 'high';

export interface BugRow {
  id: number;
  fingerprint: string;
  source: BugSource;
  error_name: string;
  message: string;
  top_frame: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  status: BugStatus;
  severity: BugSeverity;
  context_json: string | null;
  investigation_attempts: number;
  last_investigation_id: number | null;
  /** v55: manual escalation override. When non-null, takes precedence over the ring-buffer-computed severity. */
  severity_override: BugSeverity | null;
  severity_override_reason: string | null;
  severity_override_at: string | null;
}

export interface BugOccurrenceRow {
  id: number;
  bug_id: number;
  seen_at: string;
}

export interface BugInvestigationRow {
  id: number;
  bug_id: number;
  root_cause: string;
  files_to_change: string;
  lines_changed: number;
  confidence: number;
  suggested_patch: string | null;
  decided_at: string;
  brain_decision_id: number | null;
}

/**
 * v56 — ADR-030 Phase C audit row. One row per resolver attempt regardless
 * of outcome. `commit_sha` is set on success; `failure_reason` is set on
 * `unable-to-resolve`. `brain_decision_id` is reserved for Phase 77 (when
 * the resolver may escalate to the brain); always NULL in Phase 76.
 */
export type BugResolutionOutcome = 'auto-resolved' | 'unable-to-resolve';

export interface BugResolutionRow {
  id: number;
  bug_id: number;
  attempt_at: string;
  outcome: BugResolutionOutcome;
  cwd: string;
  files_changed: string | null;     // JSON array
  commit_sha: string | null;
  failure_reason: string | null;
  brain_decision_id: number | null;
}

export interface BugReportPayload {
  source: BugSource;
  errorName: string;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  context?: Record<string, unknown>;
  /** UI captures only; ignored server-side if source !== 'web-ui'. */
  build?: 'dev' | 'preview' | 'production';
}

// ─── ADR-030 Phase B (Plan 75-02 evidence library) ─────────────────────────

/** A single git log entry for the file extracted from a bug's top_frame. */
export interface BugGitLogEntry {
  sha: string;
  author: string;
  date: string;     // ISO-8601
  subject: string;
}

/** Result of /api/code-graph/blast-radius for the bug's file. */
export interface BugBlastRadius {
  repo: string;
  file: string;
  edges: Array<{ ref_type: string; src_file: string; dst_file: string }>;
  edgeCount: number;
}

/** A single recall hit from brain recall. Union kept in sync via imported RecallSource. */
export interface BugRecallHit {
  source: RecallSource;
  id: string;
  snippet: string;
  confidence: number;
  score: number;
}

/**
 * The structured evidence blob the BugInvestigatorAgent (Plan 75-03) hands
 * to the brain. Built by `gatherEvidence` in src/services/bugs/evidence.ts.
 *
 * Best-effort: every field is optional/empty when its source fails. The
 * agent must still be able to run the brain call even if every external
 * source is offline.
 */
export interface BugEvidence {
  /** Top 20 lines of the raw stack trace, or null when none. */
  stack: string | null;
  /** Mirrors BugRow.top_frame; duplicated here for the brain prompt. */
  topFrame: string | null;
  /** git log --follow --max-count=10 on the file extracted from top_frame. */
  gitLog: BugGitLogEntry[];
  /** Result of /api/code-graph/blast-radius, or null on failure. */
  blastRadius: BugBlastRadius | null;
  /** Top 5 recall hits, ranked by score, deduped across sources. */
  recall: BugRecallHit[];
}

