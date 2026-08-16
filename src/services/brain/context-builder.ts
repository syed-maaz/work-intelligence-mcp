/**
 * Brain Context Builder — Phase 69-02 (ADR-024 Pillar 2).
 *
 * Aggregates the 7-field context object served by GET /api/brain/context.
 * Composes existing canonical query shapes from web-server.js (sprint config,
 * stuck Jiras, action items, calendar today, investigation_sessions) plus the
 * 69-03 cluster detector and 69-04 staleness detectors — no duplicate query
 * logic, no HTTP self-calls.
 *
 * The 7-field shape is locked by ADR-024 Pillar 2 and must not change without
 * updating the ADR + every consumer (UI / Atlas / MCP).
 *
 * Pipeline stage: PROPOSE — composes already-stored data + already-analyzed
 * artifacts (clusters, staleness) for surfacing through a single endpoint.
 */

import type Database from 'better-sqlite3';
import type { PalaceClient } from '../../intelligence/palace-client.js';

import { detectActionClusters } from './action-cluster-detector.js';
import {
  fetchMemoryRelevantStrings,
  patternFromBrainContext,
  CONTEXT_RECALL_LIMIT,
} from './recall-context.js';
import {
  detectSprintStaleness,
  detectStuckJiraStaleness,
} from './staleness-detectors.js';

export interface BuildBrainContextOptions {
  /** MemPalace client — when connected, fills memory_relevant via recallMemory(). */
  palace?: PalaceClient | null;
  recallLimit?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Public types — match ADR-024 Pillar 2 example shape exactly.
// ──────────────────────────────────────────────────────────────────────────

export interface BrainSprintField {
  name: string;
  ends: string | null;
  fresh: boolean;
}

export interface BrainStuckJira {
  key: string;
  days_stuck: number;
  cluster: string | null;
}

export interface BrainNoiseCluster {
  signature: string;
  count: number;
  actionable_root: string | null;
}

export interface BrainCalendarEvent {
  time: string;
  title: string;
  with: string | null;
}

export interface BrainOpenInvestigation {
  key: string;
  status: string;
}

export interface BrainContext {
  sprint: BrainSprintField | null;
  stuck_jiras: BrainStuckJira[];
  noise_clusters: BrainNoiseCluster[];
  calendar_today: BrainCalendarEvent[];
  open_investigations: BrainOpenInvestigation[];
  memory_relevant: string[];
  stale_warnings: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Internals — narrow row types matching the canonical SQL in web-server.js.
// ──────────────────────────────────────────────────────────────────────────

interface SprintConfigRow {
  sprint_name: string | null;
  end_date: string | null;
  start_date: string | null;
}

interface StuckJiraRow {
  issue_key: string;
  current_status: string;
  transitioned_at: string;
}

interface CalendarEventRow {
  start_time: string | null;
  title: string | null;
  attendees: string | null;
}

interface InvestigationRow {
  issue_key: string;
  status: string;
}

const STUCK_JIRA_DAYS = 3; // matches default in /api/jira/stuck (web-server.js:1992)
const SPRINT_FRESH_DAYS = 14; // anything older surfaces a stale_warning
const MS_PER_DAY = 86_400_000;

/**
 * Build the 7-field BrainContext object for the given user.
 *
 * `user` is currently a marker for future per-user filtering (T-69-01 cache
 * key derivation in 69-05); the Phase 69 context aggregation reads global
 * canonical sources — sprint, stuck Jiras, action clusters, today's calendar
 * — none of which are partitioned by user yet.
 */
export async function buildBrainContext(
  db: Database.Database,
  _user: string,
  options?: BuildBrainContextOptions,
): Promise<BrainContext> {
  const sprint = getSprint(db);
  const stuck_jiras = getStuckJiras(db);
  const noise_clusters = getNoiseClusters(db);
  const calendar_today = getCalendarToday(db);
  const open_investigations = getOpenInvestigations(db);
  const stale_warnings = getStaleWarnings(db);

  const base: BrainContext = {
    sprint,
    stuck_jiras,
    noise_clusters,
    calendar_today,
    open_investigations,
    memory_relevant: [],
    stale_warnings,
  };

  const pattern = patternFromBrainContext(base);
  const memory_relevant = await fetchMemoryRelevantStrings({
    db,
    palace: options?.palace ?? null,
    pattern,
    limit: options?.recallLimit ?? CONTEXT_RECALL_LIMIT,
  });

  return { ...base, memory_relevant };
}

/**
 * Mirror of GET /api/config/sprint (web-server.js:1801-1818). `fresh` is true
 * when the active sprint started within the last SPRINT_FRESH_DAYS days.
 */
function getSprint(db: Database.Database): BrainSprintField | null {
  const row = db
    .prepare('SELECT sprint_name, start_date, end_date FROM sprint_config WHERE active = 1 LIMIT 1')
    .get() as SprintConfigRow | undefined;

  if (!row || !row.sprint_name) return null;

  let fresh = true;
  if (row.start_date) {
    const startMs = Date.parse(row.start_date);
    if (!Number.isNaN(startMs)) {
      fresh = Date.now() - startMs <= SPRINT_FRESH_DAYS * MS_PER_DAY;
    }
  }

  return {
    name: row.sprint_name,
    ends: row.end_date ?? null,
    fresh,
  };
}

/**
 * Mirror of GET /api/jira/stuck (web-server.js:1990-2008) restricted to the
 * fields the brain context needs (key, days_stuck, cluster).
 *
 * `cluster` is sourced from `brain_action_clusters.root_cause` keyed by the
 * issue prefix when available; left null otherwise. ADR-024's example shows
 * `"cluster": "ADR-0058"` for stuck items that map onto a known root cause —
 * for Phase 69 alpha we emit null rather than guess.
 */
function getStuckJiras(db: Database.Database): BrainStuckJira[] {
  const rows = db
    .prepare(
      `SELECT jt.issue_key, jt.to_status AS current_status, jt.transitioned_at
       FROM jira_transitions jt
        WHERE jt.project_key = '${process.env.JIRA_PROJECT_KEY ?? 'PROJ'}'
         AND jt.to_status NOT IN ('Done', 'Closed', 'Resolved', 'Cancelled', 'Completed')
         AND NOT EXISTS (
           SELECT 1 FROM jira_transitions jt2
           WHERE jt2.issue_key = jt.issue_key AND jt2.transitioned_at > jt.transitioned_at
         )
         AND jt.transitioned_at < datetime('now', '-' || ? || ' days')
       ORDER BY jt.transitioned_at ASC
       LIMIT 20`,
    )
    .all(STUCK_JIRA_DAYS) as StuckJiraRow[];

  const now = Date.now();
  const out: BrainStuckJira[] = [];
  for (const row of rows) {
    const tsMs = Date.parse(row.transitioned_at.replace(' ', 'T') + 'Z');
    const days = Number.isNaN(tsMs) ? STUCK_JIRA_DAYS : Math.floor((now - tsMs) / MS_PER_DAY);
    out.push({ key: row.issue_key, days_stuck: days, cluster: null });
  }
  return out;
}

/**
 * Top-N action-item noise clusters via the 69-03 detector. Re-runs the
 * detector on every miss — it's a single SELECT + UPSERT pass over the
 * action_items table, well under the warm-cache target.
 */
function getNoiseClusters(db: Database.Database): BrainNoiseCluster[] {
  let clusters;
  try {
    clusters = detectActionClusters(db, { topN: 5 });
  } catch {
    return [];
  }
  return clusters.map((c) => ({
    signature: c.signature,
    count: c.count,
    actionable_root: c.root_cause,
  }));
}

/**
 * Today's calendar events, formatted for context. Mirrors the SELECT shape
 * used by the daily-summary path (web-server.js:4348) — `date(start_time) = ?`
 * keyed off today's UTC ISO date.
 */
function getCalendarToday(db: Database.Database): BrainCalendarEvent[] {
  const today = new Date().toISOString().slice(0, 10);
  let rows: CalendarEventRow[];
  try {
    rows = db
      .prepare(
        `SELECT start_time, title, attendees
         FROM calendar_events
         WHERE date(start_time) = ?
         ORDER BY start_time ASC`,
      )
      .all(today) as CalendarEventRow[];
  } catch {
    return [];
  }

  return rows.map((row) => ({
    time: extractTime(row.start_time),
    title: row.title ?? '(untitled)',
    with: extractFirstAttendee(row.attendees),
  }));
}

function extractTime(startTime: string | null): string {
  if (!startTime) return '';
  // start_time stored as ISO 8601; pull HH:MM in local time of the string.
  const m = startTime.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

function extractFirstAttendee(raw: string | null): string | null {
  if (!raw) return null;
  // attendees is stored as a JSON array string in calendar_events; fall back
  // to splitting on common delimiters when JSON parse fails.
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object' && 'email' in first) {
        return String((first as { email: unknown }).email);
      }
      if (first && typeof first === 'object' && 'name' in first) {
        return String((first as { name: unknown }).name);
      }
    }
  } catch {
    /* fall through */
  }
  const parts = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts[0] : null;
}

/**
 * Investigation sessions currently in 'running' state. Mirrors the schema in
 * src/db/schema.ts:905-920. Surfaces the issue_key + status fields ADR-024
 * Pillar 2 example calls out.
 */
function getOpenInvestigations(db: Database.Database): BrainOpenInvestigation[] {
  let rows: InvestigationRow[];
  try {
    rows = db
      .prepare(
        `SELECT issue_key, status
         FROM investigation_sessions
         WHERE status = 'running'
         ORDER BY started_at DESC
         LIMIT 10`,
      )
      .all() as InvestigationRow[];
  } catch {
    return [];
  }
  return rows.map((row) => ({ key: row.issue_key, status: row.status }));
}

/**
 * Stale warnings via the 69-04 detectors — sprint freshness + stuck-Jira
 * threshold breaches. Each detector is wrapped so a missing table (e.g. on a
 * fresh DB) cannot poison the whole context response.
 */
function getStaleWarnings(db: Database.Database): string[] {
  const warnings: string[] = [];
  try {
    warnings.push(...detectSprintStaleness(db));
  } catch {
    /* best effort */
  }
  try {
    warnings.push(...detectStuckJiraStaleness(db));
  } catch {
    /* best effort */
  }
  return warnings;
}
