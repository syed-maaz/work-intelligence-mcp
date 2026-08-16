/**
 * Action-cluster detector — Phase 69-03 (ADR-024 Unified Brain).
 *
 * Groups noisy duplicate action items into clusters keyed by a stable
 * `signature` of the form `${error_type}::${source_system}`, persists them
 * to `brain_action_clusters` (table created by Phase 69-01 v45 migration),
 * and returns the top-N clusters ranked by count DESC for the
 * `/api/brain/context` endpoint's `noise_clusters` field.
 *
 * Pipeline stage: PROCESS (groups already-stored data) → PROPOSE (returns
 * top-N for surfacing). No external API calls. No AI.
 *
 * Threat-model mitigation (T-69-02): the signature combines BOTH
 * `error_type` AND `source_system` so unrelated errors from different
 * systems cannot collide on the same cluster row.
 *
 * Idempotency: re-running the detector preserves any manually-set
 * `root_cause` or `resolution` values — the UPSERT only touches
 * `count` and `last_seen` on existing rows.
 */

import type Database from 'better-sqlite3';

export interface ActionCluster {
  signature: string;
  error_type: string;
  source_system: string;
  count: number;
  first_seen: number; // unix epoch seconds (UTC)
  last_seen: number; // unix epoch seconds (UTC)
  root_cause: string | null;
  resolution: string | null;
}

export interface DetectActionClustersOptions {
  /** Top-N clusters to return, ranked by count DESC. Default: 10. */
  topN?: number;
}

interface ActionItemRow {
  description: string | null;
  title: string | null;
  source: string | null;
  /** ISO timestamp from messages.timestamp (e.g. '2026-05-18 14:30:00'). May be null when source_message_id is null. */
  created_at: string | null;
}

interface ClusterAggregate {
  signature: string;
  error_type: string;
  source_system: string;
  count: number;
  first_seen: number;
  last_seen: number;
}

const DEFAULT_TOP_N = 10;
const UNKNOWN_SOURCE = 'unknown';

/**
 * Normalize a free-form action-item description into a canonical
 * error-type token used for clustering. Strips ticket IDs, ISO timestamps
 * and other volatile noise, lowercases, and collapses whitespace.
 *
 * Pure function — exported only for unit testing in 69-06.
 */
export function canonicalErrorType(input: string): string {
  if (!input) return 'unknown';
  let s = input.toLowerCase();
  // Strip ISO timestamps (2026-05-18T14:30:00, 2026-05-18 14:30:00Z, etc.)
  s = s.replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2})?z?/g, '');
  // Strip plain dates (2026-05-18, 2026/05/18)
  s = s.replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, '');
  // Strip Jira-style ticket IDs (JIRA-15257, JIRA-93, ABC-1234)
  s = s.replace(/\b[A-Z][A-Z0-9]+-\d+\b/gi, '');
  // Strip standalone long digit runs (epoch ms, ids ≥ 4 digits)
  s = s.replace(/\b\d{4,}\b/g, '');
  // Strip URLs
  s = s.replace(/https?:\/\/\S+/g, '');
  // Collapse non-alphanumeric runs to single space
  s = s.replace(/[^a-z0-9]+/g, ' ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 0 ? s : 'unknown';
}

/**
 * Convert an ISO-style SQLite timestamp string to unix epoch seconds (UTC).
 * SQLite stores `messages.timestamp` as `datetime('now')` text. Date.parse
 * treats space-separated SQLite datetimes as UTC when no timezone marker
 * is present on most engines, so we append 'Z' defensively if missing.
 */
function isoToEpochSeconds(iso: string | null): number {
  if (!iso) return 0;
  // SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS' (no TZ). Treat as UTC.
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return 0;
  return Math.floor(ms / 1000);
}

/**
 * Detect action-item clusters, persist to `brain_action_clusters`,
 * and return the top-N ranked by count DESC.
 *
 * Reads `action_items` LEFT JOIN `messages` ON source_message_id (matches
 * the existing JOIN shape used in web-server.js / digests). Items without
 * a linked message contribute `source = 'unknown'` and `created_at = 0`.
 *
 * UPSERT preserves manual `root_cause` / `resolution` overrides — only
 * `count` and `last_seen` are mutated on existing rows (overwritten with
 * the freshly-recomputed values), and `first_seen` is INSERT-only.
 */
export function detectActionClusters(
  db: Database.Database,
  opts: DetectActionClustersOptions = {},
): ActionCluster[] {
  const topN = opts.topN ?? DEFAULT_TOP_N;

  // 1. Pull action items joined with their source message for source + created_at.
  //    `action_items` has no `source` or `created_at` columns directly — those
  //    live on the linked `messages` row (project CLAUDE.md, verified columns).
  const rows = db
    .prepare(
      `SELECT a.description       AS description,
              a.title             AS title,
              m.source            AS source,
              m.timestamp         AS created_at
       FROM action_items a
       LEFT JOIN messages m ON a.source_message_id = m.id`,
    )
    .all() as ActionItemRow[];

  // 2. Aggregate by signature in memory.
  const aggregates = new Map<string, ClusterAggregate>();
  for (const row of rows) {
    // Prefer description for error-type derivation; fall back to title when null.
    const sourceText = row.description ?? row.title ?? '';
    const errorType = canonicalErrorType(sourceText);
    const sourceSystem = (row.source ?? UNKNOWN_SOURCE).toLowerCase();
    const signature = `${errorType}::${sourceSystem}`;
    const ts = isoToEpochSeconds(row.created_at);

    const existing = aggregates.get(signature);
    if (existing) {
      existing.count += 1;
      if (ts > 0 && (existing.first_seen === 0 || ts < existing.first_seen)) {
        existing.first_seen = ts;
      }
      if (ts > existing.last_seen) {
        existing.last_seen = ts;
      }
    } else {
      aggregates.set(signature, {
        signature,
        error_type: errorType,
        source_system: sourceSystem,
        count: 1,
        first_seen: ts,
        last_seen: ts,
      });
    }
  }

  // 3. UPSERT all aggregates into brain_action_clusters in a single transaction.
  //    Per ADR-024 locked DDL, the table has columns:
  //      signature TEXT PRIMARY KEY, count INTEGER, first_seen INTEGER,
  //      last_seen INTEGER, root_cause TEXT, resolution TEXT
  //
  //    The ON CONFLICT clause OVERWRITES count and last_seen with the
  //    freshly-computed values (per plan 69-03 spec line 51) — the
  //    detector recomputes count from scratch over the full action_items
  //    window on every run, so re-running stays idempotent. first_seen
  //    is INSERT-only, and root_cause / resolution are deliberately not
  //    touched so any manual override placed by an operator survives.
  const upsert = db.prepare(
    `INSERT INTO brain_action_clusters
       (signature, count, first_seen, last_seen, root_cause, resolution)
     VALUES (?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(signature) DO UPDATE SET
       count      = excluded.count,
       last_seen  = excluded.last_seen`,
  );

  const writeAll = db.transaction((entries: ClusterAggregate[]) => {
    for (const entry of entries) {
      upsert.run(entry.signature, entry.count, entry.first_seen, entry.last_seen);
    }
  });
  writeAll([...aggregates.values()]);

  // 4. Read back the top-N with persisted counts and any pre-existing
  //    root_cause / resolution overrides.
  const persisted = db
    .prepare(
      `SELECT signature, count, first_seen, last_seen, root_cause, resolution
       FROM brain_action_clusters
       ORDER BY count DESC, last_seen DESC
       LIMIT ?`,
    )
    .all(topN) as Array<{
      signature: string;
      count: number;
      first_seen: number | null;
      last_seen: number | null;
      root_cause: string | null;
      resolution: string | null;
    }>;

  return persisted.map((row) => {
    const [errorType, sourceSystem] = splitSignature(row.signature);
    return {
      signature: row.signature,
      error_type: errorType,
      source_system: sourceSystem,
      count: row.count ?? 0,
      first_seen: row.first_seen ?? 0,
      last_seen: row.last_seen ?? 0,
      root_cause: row.root_cause,
      resolution: row.resolution,
    };
  });
}

/**
 * Split a `${error_type}::${source_system}` signature back into its parts.
 * `error_type` itself never contains `::` because canonicalErrorType
 * collapses non-alphanumerics to spaces, so the first `::` is unambiguous.
 */
function splitSignature(signature: string): [string, string] {
  const idx = signature.indexOf('::');
  if (idx < 0) return [signature, UNKNOWN_SOURCE];
  return [signature.slice(0, idx), signature.slice(idx + 2)];
}
