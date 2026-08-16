/**
 * Phase 71-05 — recall orchestrator (POST /api/brain/recall backend).
 *
 * ADR-024 Pillar 4 — "have we seen this before?" Combines three knowledge
 * stores into one ranked list so consumers (chat, decide, verify, future
 * automations) only need to ask one question instead of stitching three.
 *
 * Sources, queried in parallel:
 *   1. MemPalace semantic search (`palace.query(pattern)`).
 *   2. SQLite `brain_decisions` rows where pattern LIKE question/decision/rationale.
 *   3. SQLite `brain_action_clusters` rows where pattern LIKE signature.
 *
 * Each source is normalized to a uniform `RecallResult`:
 *   { source, id, snippet, confidence, score, created_at }
 *
 * Ranking — `score = recency_weight * confidence`, where
 *   recency_weight = 1 / (1 + days_old / 30).
 *
 * That formula keeps the math monotonic (a today-result with confidence c
 * always outranks a >0-day-old result with the same c) while halving the
 * weight of a 30-day-old hit and quartering a 90-day-old one.
 *
 * Resilience: palace failures (offline, MemPalace not installed, transport
 * error) are swallowed — the SQL sources still return. SQLite query errors
 * are logged and treated as "no results from that source" rather than
 * surfacing a 500 to the caller.
 */

import type Database from 'better-sqlite3';
import type { PalaceClient } from '../../intelligence/palace-client.js';
import {
  queryMessageCosine,
  queryPromptMemoryCosine,
  queryDocCosine,
  type CosineHit,
} from './recall-embeddings.js';
import { rrfMerge, type Rankable } from './rrf-merge.js';

export type RecallSource =
  | 'palace'
  | 'decision'
  | 'cluster'
  | 'verification'
  | 'observation'
  | 'obsidian'
  | 'message_cosine'
  | 'prompt_memory_cosine'
  | 'doc_cosine';

export interface RecallResult {
  source: RecallSource;
  id: string;
  snippet: string;
  /** 0..1 — confidence pulled from the source row, defaulting to 0.5 when
   *  the source does not record one (e.g. raw clusters). */
  confidence: number;
  /** recency_weight * confidence, computed at recall time. */
  score: number;
  /** ISO-8601 timestamp of when the row was created / last seen. */
  created_at: string;
}

export interface RecallMemoryArgs {
  db: Database.Database;
  pattern: string;
  limit?: number;
  /** Optional palace client. When omitted (or null/disconnected), palace
   *  source is silently skipped. */
  palace?: PalaceClient | null;
  /**
   * Phase 78a-04 (CHAT-03): mode-scoped wings filter for the palace search.
   *
   * Semantics:
   *   - `undefined` or `[]` (default) → cross-wing baseline. Backward-compat
   *     for every existing recallMemory caller (none pass wings today). The
   *     palace search is invoked exactly as before, and brain_decisions /
   *     brain_action_clusters are merged in unfiltered.
   *   - non-empty `string[]` → restrict palace results to drawers whose
   *     `metadata.wing` is in the requested set, AND drop the SQLite
   *     decisions/clusters merge entirely (those tables don't carry a `wing`
   *     column in 78a, so they can't be wing-filtered without false positives;
   *     the safer default is to return mode-scoped palace rows only when a
   *     specific wings filter is requested).
   *
   * NO validation in 78a — strings are passed through as-is. Phase 78c will
   * add strict 7-wing validation when it ships the `life` wing.
   */
  wings?: string[];
  /**
   * Phase 79-01: control whether SQLite lanes (brain_decisions,
   * brain_action_clusters, brain_verifications) participate in this recall.
   *
   * Decouples SQLite lanes from the `wings` filter. Prior to Phase 79-01,
   * SQLite lanes were silently dropped whenever `wings.length > 0`, because
   * decisions/clusters/verifications don't carry a `wing` column. That
   * behavior made everyday work-mode chat (which passes 6 work wings on
   * every message) unable to see 157 brain_decisions, 300 brain_action_clusters,
   * and 0 brain_verifications. See ADR-047 D1.
   *
   * Semantics:
   *   - `undefined` (default) → SQLite lanes participate regardless of wings.
   *   - `true`                → same as default; explicit opt-in.
   *   - `false`               → SQLite lanes are dropped; only palace runs.
   *                             Kept as an escape hatch for wing-strict callers
   *                             that need cross-wing leakage protection.
   */
  sqliteLanes?: boolean;
  /**
   * Phase 79-5b: pre-computed query embedding blob for cosine lanes.
   *
   * When provided, three additional recall lanes fire:
   *   - message_cosine (over message_embeddings)
   *   - prompt_memory_cosine (over prompt_memory, success/completed only)
   *   - doc_cosine (over doc_embeddings)
   *
   * All lanes are merged via Reciprocal Rank Fusion k=60, replacing the simple
   * score-sort. When null/undefined, cosine lanes are skipped and existing
   * LIKE/FTS lanes merge as before.
   *
   * The cosine_similarity() SQLite UDF must be registered on `db` before
   * calling recallMemory with a non-null queryBlob (see registerCosineUDF in
   * cosine-udf.ts). Unregistered = cosine queries will throw; errors are
   * caught and treated as empty lanes.
   */
  queryBlob?: Buffer | null;
  /** Test seam — defaults to Date.now(). */
  now?: () => number;
}

export class InvalidRecallArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecallArgsError';
  }
}

/**
 * recency_weight = 1 / (1 + days_old/30). Negative days (clock skew, future
 * timestamps) are clamped to 0 so the weight never exceeds 1.
 */
export function recencyWeight(createdAtMs: number, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - createdAtMs);
  const daysOld = ageMs / (1000 * 60 * 60 * 24);
  return 1 / (1 + daysOld / 30);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function clampConfidence(c: unknown): number {
  if (typeof c !== 'number' || !Number.isFinite(c)) return 0.5;
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

/**
 * Sanitize a free-text pattern for safe FTS5 MATCH use.
 *
 * F4 + F8 fix (audit): FTS5 treats several characters as syntax:
 *   " (phrase delimiter), * (prefix), - (NOT/exclusion when followed by term),
 *   ( ) (grouping), : (column filter), ^ (initial-token), .
 *
 * Real-world inputs include hyphenated IDs like "JIRA-17726", parenthesized
 * clarifiers, and Windows paths — all of which cause the FTS5 parser to
 * throw or return unexpected results (e.g. -17726 parses as NOT 17726).
 *
 * Strategy: replace every FTS5 metacharacter with a space, collapse runs of
 * whitespace to a single space, tokenize on whitespace, filter zero-length,
 * then wrap each remaining token in double quotes to force phrase-literal
 * interpretation. Empty result -> caller should short-circuit.
 *
 * Examples:
 *   "search proxy"      -> `"search" "proxy"`
 *   "JIRA-17726"        -> `"JIRA" "17726"`
 *   'foo (bar) - baz'  -> `"foo" "bar" "baz"`
 *   '""'               -> ''
 */
function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw.replace(/["*\-():^.]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

interface DecisionRow {
  id: string;
  question: string;
  decision: string;
  rationale: string | null;
  confidence: number | null;
  created_at: number;
}

interface ClusterRow {
  signature: string;
  count: number | null;
  last_seen: number | null;
  first_seen: number | null;
  root_cause: string | null;
  resolution: string | null;
}

/**
 * Pull matching `brain_decisions` rows. Synchronous (better-sqlite3) but
 * wrapped in a try/catch so a query error never crashes the orchestrator.
 */
function queryDecisions(
  db: Database.Database,
  pattern: string,
  nowMs: number,
): RecallResult[] {
  try {
    const like = `%${pattern}%`;
    const rows = db
      .prepare(
        `SELECT id, question, decision, rationale, confidence, created_at
         FROM brain_decisions
         WHERE question LIKE ? OR decision LIKE ? OR rationale LIKE ?
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all(like, like, like) as DecisionRow[];
    return rows.map((r) => {
      const confidence = clampConfidence(r.confidence);
      const snippet = `${r.question} → ${r.decision}`.slice(0, 240);
      const score = recencyWeight(r.created_at, nowMs) * confidence;
      return {
        source: 'decision',
        id: r.id,
        snippet,
        confidence,
        score,
        created_at: toIso(r.created_at),
      };
    });
  } catch (err) {
    console.error('[brain/recall] decisions query failed:', err);
    return [];
  }
}

/**
 * Pull matching `brain_action_clusters` rows. Clusters do not record a
 * confidence — we map count → confidence via 1 - 1/(1+count) so a cluster
 * seen many times outranks a one-off, but a one-off still gets non-zero
 * weight (0.5).
 */
function queryClusters(
  db: Database.Database,
  pattern: string,
  nowMs: number,
): RecallResult[] {
  try {
    const like = `%${pattern}%`;
    const rows = db
      .prepare(
        `SELECT signature, count, first_seen, last_seen, root_cause, resolution
         FROM brain_action_clusters
         WHERE signature LIKE ?
         ORDER BY last_seen DESC NULLS LAST
         LIMIT 200`,
      )
      .all(like) as ClusterRow[];
    return rows.map((r) => {
      const count = Math.max(1, r.count ?? 1);
      // count=1 → 0.5; count=5 → 0.83; count=20 → 0.95.
      const confidence = 1 - 1 / (1 + count);
      const tsMs = r.last_seen ?? r.first_seen ?? nowMs;
      const snippetParts = [r.signature];
      if (r.root_cause) snippetParts.push(`cause: ${r.root_cause}`);
      if (r.resolution) snippetParts.push(`fix: ${r.resolution}`);
      const snippet = snippetParts.join(' | ').slice(0, 240);
      const score = recencyWeight(tsMs, nowMs) * confidence;
      return {
        source: 'cluster',
        id: r.signature,
        snippet,
        confidence,
        score,
        created_at: toIso(tsMs),
      };
    });
  } catch (err) {
    console.error('[brain/recall] clusters query failed:', err);
    return [];
  }
}

interface PalaceHit {
  id?: string;
  doc_id?: string;
  text?: string;
  content?: string;
  snippet?: string;
  score?: number;
  confidence?: number;
  timestamp?: string | number;
  created_at?: string | number;
  metadata?: Record<string, unknown>;
}

/**
 * Best-effort parse of MemPalace's JSON search response. The shape varies
 * across MemPalace versions — we accept either a top-level array or a
 * `{results: [...]}` wrapper, and tolerate missing fields by filling in
 * defaults (mid-confidence, "now" timestamp).
 */
function parsePalaceHits(raw: string): PalaceHit[] {
  if (!raw || typeof raw !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed as PalaceHit[];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { results?: unknown; hits?: unknown };
    if (Array.isArray(obj.results)) return obj.results as PalaceHit[];
    if (Array.isArray(obj.hits)) return obj.hits as PalaceHit[];
  }
  return [];
}

async function queryPalace(
  palace: PalaceClient | null | undefined,
  pattern: string,
  nowMs: number,
  limit: number,
  wings: string[] = [],
): Promise<RecallResult[]> {
  if (!palace) return [];
  // PalaceClient.isConnected may be a getter; check defensively.
  try {
    const connected = (palace as { isConnected?: boolean }).isConnected;
    if (connected === false) return [];
  } catch {
    /* ignore — older clients may not expose isConnected */
  }

  let raw = '';
  try {
    // Push the wing filter down to MemPalace when exactly one wing is
    // requested — server-side filtering by wing is reliable, whereas the
    // JS-side metadata.wing check is best-effort (mempalace's search
    // result shape varies and metadata is not consistently echoed back).
    // 77a-01 soak (2026-06-12) surfaced the leak: cross-wing semantic
    // matches landed at lower ranks even when wings:['reviews'] was set.
    // For the multi-wing case (only fires in 78a chat-life-mode today)
    // we keep the per-hit JS filter below as a defensive second pass.
    const palaceWing = wings.length === 1 ? wings[0] : undefined;
    raw = await palace.search(pattern, palaceWing, Math.max(limit, 5));
  } catch (err) {
    console.error('[brain/recall] palace search failed:', err);
    return [];
  }
  const hits = parsePalaceHits(raw);
  // 78a-04: when a non-empty wings filter is supplied, drop hits that don't
  // carry a metadata.wing in the requested set. Defensive second pass —
  // when palaceWing was passed above, mempalace already filtered server-
  // side and this becomes a no-op. When wings.length > 1, this is the
  // primary filter.
  const filteredHits = wings.length === 0
    ? hits
    : hits.filter((h) => {
        const wing =
          (h.metadata && typeof h.metadata === 'object'
            ? (h.metadata as { wing?: unknown }).wing
            : undefined);
        return typeof wing === 'string' && wings.includes(wing);
      });
  return filteredHits.map((h, idx) => {
    const id = String(h.id ?? h.doc_id ?? `palace-${idx}`);
    const snippet = String(h.snippet ?? h.text ?? h.content ?? '').slice(0, 240);
    // Palace returns either `score` (cosine 0..1) or `confidence`. Either
    // way clamp and treat as confidence input to the ranking formula.
    const confidence = clampConfidence(h.confidence ?? h.score ?? 0.5);
    const ts = h.created_at ?? h.timestamp;
    let tsMs = nowMs;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      tsMs = ts > 1e12 ? ts : ts * 1000;
    } else if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      if (!Number.isNaN(parsed)) tsMs = parsed;
    }
    return {
      source: 'palace',
      id,
      snippet,
      confidence,
      score: recencyWeight(tsMs, nowMs) * confidence,
      created_at: toIso(tsMs),
    };
  });
}

/**
 * Phase 79-08: Pull matching obsidian_notes rows as a 6th recall lane.
 *
 * User annotations (below SEPARATOR) get a +25% score boost — user corrections
 * are load-bearing and should rank above auto-generated WI body text.
 * Uses FTS5 MATCH for speed; falls back gracefully if the table doesn't exist.
 *
 * Task 8.6 — wikilink expansion: when the pattern mentions a person name
 * (heuristic: two consecutive Title-Case words), also query notes whose
 * wikilinks_json contains that name. Unlocks "prep me for a meeting with a
 * teammate" without the note needing to match the name in its body.
 */
function queryObsidianNotes(
  db: Database.Database,
  pattern: string,
  nowMs: number,
  limit: number,
): RecallResult[] {
  type NoteRow = {
    id: number;
    file_name: string;
    topic_name: string | null;
    wi_body: string | null;
    user_annotations: string | null;
    file_mtime_epoch: number;
    snippet: string | null;
    user_boost: number;
  };

  const toResult = (r: NoteRow): RecallResult => ({
    source: 'obsidian' as const,
    id: `obsidian:${r.file_name}`,
    snippet: (r.snippet ?? r.file_name).replace(/\s+/g, ' ').trim(),
    confidence: 0.8,
    score: recencyWeight(r.file_mtime_epoch, nowMs) * r.user_boost,
    created_at: toIso(r.file_mtime_epoch),
  });

  const likeLower = `%${pattern.toLowerCase()}%`;

  try {
    // F4 fix (audit): sanitize FTS5 pattern comprehensively — old code only
    // stripped " and *, letting -, (, ), :, ^, . reach FTS5 and cause parse
    // errors on inputs like "JIRA-17726" (parses as `JIRA NOT 17726`).
    const ftsQuery = sanitizeFtsQuery(pattern);
    if (!ftsQuery) return [];

    const ftsRows = db
      .prepare(
        `SELECT
           n.id,
           n.file_name,
           n.topic_name,
           n.wi_body,
           n.user_annotations,
           n.file_mtime_epoch,
           CASE
             WHEN n.user_annotations IS NOT NULL AND n.user_annotations != ''
               AND lower(n.user_annotations) LIKE ?
             THEN substr(n.user_annotations, 1, 400)
             ELSE substr(n.wi_body, 1, 400)
           END AS snippet,
           CASE
             WHEN n.user_annotations IS NOT NULL AND n.user_annotations != ''
               AND lower(n.user_annotations) LIKE ?
             THEN 1.25
             ELSE 1.0
           END AS user_boost
         FROM obsidian_notes_fts
         JOIN obsidian_notes n ON obsidian_notes_fts.rowid = n.id
         WHERE obsidian_notes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(likeLower, likeLower, ftsQuery, limit) as NoteRow[];

    // Task 8.6: wikilink expansion — detect person name (two Title-Case words)
    // and query notes that link to that person even if the body doesn't match.
    const seenIds = new Set(ftsRows.map((r) => r.id));
    const wikilinkRows: NoteRow[] = [];
    const personMatch = pattern.match(/\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b/);
    if (personMatch) {
      const personName = `${personMatch[1]} ${personMatch[2]}`;
      // F1 fix (audit): use parameterized json_each to avoid SQL string
      // interpolation of seenIds. Current values are integer PKs (safe today),
      // but this file uses prepare() correctly everywhere else — no reason to
      // keep the one string-interpolation hole. json_each takes a JSON array
      // literal as a single bound parameter and yields rows we can subquery.
      const seenIdsJson = JSON.stringify([...seenIds]);
      const wikilinkRows2 = db
        .prepare(
          `SELECT
             n.id,
             n.file_name,
             n.topic_name,
             n.wi_body,
             n.user_annotations,
             n.file_mtime_epoch,
             substr(coalesce(n.user_annotations, n.wi_body, ''), 1, 400) AS snippet,
             1.1 AS user_boost
           FROM obsidian_notes n
           WHERE n.wikilinks_json LIKE ?
             AND n.id NOT IN (SELECT value FROM json_each(?))
           ORDER BY n.file_mtime_epoch DESC
           LIMIT ?`,
        )
        .all(`%${personName}%`, seenIdsJson, Math.ceil(limit / 2)) as NoteRow[];
      wikilinkRows.push(...wikilinkRows2);
    }

    return [...ftsRows, ...wikilinkRows].map(toResult);
  } catch (err) {
    // Table may not exist yet on older schema versions — non-fatal
    const msg = (err as Error).message ?? '';
    if (!msg.includes('no such table')) {
      console.error('[brain/recall] obsidian_notes query failed:', err);
    }
    return [];
  }
}

/**
 * Pull matching `brain_verifications` rows. Phase 88-1 — wire previously
 * verified claims into recall so the system surfaces "you already checked this."
 */
function queryVerifications(
  db: Database.Database,
  pattern: string,
  nowMs: number,
): RecallResult[] {
  try {
    const like = `%${pattern}%`;
    const rows = db
      .prepare(
        `SELECT id, claim, verified, confidence, checked_at
         FROM brain_verifications
         WHERE claim LIKE ?
         ORDER BY checked_at DESC
         LIMIT 200`,
      )
      .all(like) as Array<{
        id: string;
        claim: string;
        verified: number;
        confidence: number | null;
        checked_at: number;
      }>;
    return rows.map((r) => {
      const confidence = clampConfidence(r.confidence ?? 0.7);
      const snippet = `${r.verified ? '✅' : '❌'} ${r.claim}`.slice(0, 240);
      const score = recencyWeight(r.checked_at, nowMs) * confidence;
      return {
        source: 'verification',
        id: r.id,
        snippet,
        confidence,
        score,
        created_at: toIso(r.checked_at),
      };
    });
  } catch (err) {
    console.error('[brain/recall] verifications query failed:', err);
    return [];
  }
}

interface ExternalObservationRow {
  id: number;
  id_key: string;
  snippet: string;
  created_at: number;
}

/**
 * Phase 79-07: pull matching rows from external_observations_fts.
 * FTS5 MATCH query over title/subtitle/narrative/facts_json/concepts_json.
 * Falls back gracefully if the table doesn't exist (pre-v105 DB).
 */
function queryExternalObservations(
  db: Database.Database,
  pattern: string,
  nowMs: number,
): RecallResult[] {
  try {
    // F8 fix (audit): pattern must go through FTS5 sanitizer, same as
    // queryObsidianNotes — was previously passed raw and misbehaved on
    // hyphenated IDs, parentheses, etc. (silently degraded via try/catch
    // in the pre-fix world; now succeeds properly).
    const ftsQuery = sanitizeFtsQuery(pattern);
    if (!ftsQuery) return [];

    const rows = db
      .prepare(
        `SELECT
           eo.id,
           eo.source || ':' || eo.source_row_id AS id_key,
           coalesce(eo.narrative, eo.text, eo.title, '') AS snippet,
           eo.observation_created_at_epoch AS created_at
         FROM external_observations_fts
         JOIN external_observations eo ON external_observations_fts.rowid = eo.id
         WHERE external_observations_fts MATCH ?
         ORDER BY rank
         LIMIT 200`,
      )
      .all(ftsQuery) as ExternalObservationRow[];
    return rows.map((r) => {
      const snippet = r.snippet.slice(0, 240);
      const score = recencyWeight(r.created_at, nowMs) * 0.7;
      return {
        source: 'observation' as RecallSource,
        id: r.id_key,
        snippet,
        confidence: 0.7,
        score,
        created_at: toIso(r.created_at),
      };
    });
  } catch (err) {
    console.error('[brain/recall] external_observations query failed:', err);
    return [];
  }
}

/**
 * Combined recall path. Fans out the four sources, merges, ranks, slices.
 *
 * Throws `InvalidRecallArgsError` on empty/missing pattern so callers can
 * map cleanly to a 400. All other errors are absorbed at the source level
 * and surface as "that source returned no rows".
 *
 * Phase 78a-04 wings semantics:
 *   - `wings: []` (default) → cross-wing baseline (palace + decisions + clusters
 *     all participate; identical to pre-78a behavior).
 *   - `wings: [...non-empty]` → mode-scoped path. Palace results are filtered
 *     by metadata.wing membership; brain_decisions / brain_action_clusters
 *     are dropped from the merge (no `wing` column in 78a — see RecallMemoryArgs
 *     JSDoc). Phase 78c will revisit if those tables grow a wing column.
 */
export async function recallMemory(args: RecallMemoryArgs): Promise<RecallResult[]> {
  const { db, pattern, palace = null, now = Date.now } = args;
  const wings = Array.isArray(args.wings) ? args.wings : [];
  const limit = Math.max(1, Math.min(100, args.limit ?? 10));

  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new InvalidRecallArgsError('pattern is required');
  }
  const trimmed = pattern.trim();
  const nowMs = now();

  // Fan out — palace is async, SQL queries are synchronous but cheap.
  // Phase 79-01: SQLite lanes are independent of the wings filter.
  // `wings` still scopes the palace search; SQLite participation is controlled
  // by `sqliteLanes` (default true). See RecallMemoryArgs.sqliteLanes doc.
  const sqliteEnabled = args.sqliteLanes !== false;
  const queryBlob = args.queryBlob ?? null;

  const [palaceSettled, decisions, clusters, verifications, observations, obsidianNotes] = await Promise.all([
    Promise.resolve()
      .then(() => queryPalace(palace, trimmed, nowMs, limit, wings))
      .catch((err) => {
        console.error('[brain/recall] palace orchestrator failure:', err);
        return [] as RecallResult[];
      }),
    Promise.resolve(sqliteEnabled ? queryDecisions(db, trimmed, nowMs) : []),
    Promise.resolve(sqliteEnabled ? queryClusters(db, trimmed, nowMs) : []),
    Promise.resolve(sqliteEnabled ? queryVerifications(db, trimmed, nowMs) : []),
    Promise.resolve(sqliteEnabled ? queryExternalObservations(db, trimmed, nowMs) : []),
    // Phase 79-08: obsidian vault as 6th lane (non-fatal if table absent)
    Promise.resolve(sqliteEnabled ? queryObsidianNotes(db, trimmed, nowMs, limit) : []),
  ]);

  // Phase 79-5b: cosine lanes fire when queryBlob is provided.
  const msgCosine: CosineHit[] = queryBlob ? queryMessageCosine(db, queryBlob, limit) : [];
  const promptMemCosine: CosineHit[] = queryBlob ? queryPromptMemoryCosine(db, queryBlob, limit) : [];
  const docCosine: CosineHit[] = queryBlob ? queryDocCosine(db, queryBlob, limit) : [];

  // F2 fix (audit): namespace all Rankable ids by source before RRF so the merge
  // and rehydration cannot collide across lanes. Two different lanes with the same
  // numeric PK (e.g. brain_decisions.id="7" and message_id=7) used to accumulate as
  // one entry in rrfMerge's score map, and the rehydration map (byId) took the
  // first-seen source — corrupting snippet/attribution. Namespacing produces
  // guaranteed-unique keys ('decision:7' vs 'message_cosine:7').
  // Public API is unchanged: RecallResult.id retains its original per-lane id.
  const nsKey = (source: string, id: string): string => `${source}:${id}`;

  // Adapt RecallResult[] → Rankable[] for RRF, with namespaced keys.
  const toRankable = (rs: RecallResult[]): Rankable[] =>
    rs.map((r) => ({ id: nsKey(r.source, r.id), score: r.score, source: r.source, snippet: r.snippet }));

  const cosineHitToRankable = (hits: CosineHit[]): Rankable[] =>
    hits.map((h) => ({ id: nsKey(h.source, h.id), score: h.score, source: h.source, snippet: h.snippet }));

  const rrfResult = rrfMerge(
    [
      toRankable(palaceSettled),
      toRankable(decisions),
      toRankable(clusters),
      toRankable(verifications),
      toRankable(observations),
      toRankable(obsidianNotes),
      cosineHitToRankable(msgCosine),
      cosineHitToRankable(promptMemCosine),
      cosineHitToRankable(docCosine),
    ],
    60,
    limit,
  );

  // Re-hydrate back to RecallResult, pulling metadata from the original arrays.
  // Each entry is stored under its own namespaced key so cross-lane PK collisions
  // (F2) can no longer overwrite each other.
  const allResults: RecallResult[] = [
    ...palaceSettled,
    ...decisions,
    ...clusters,
    ...verifications,
    ...observations,
    ...obsidianNotes,
    ...msgCosine.map((h) => ({
      source: 'message_cosine' as RecallSource,
      id: h.id,
      snippet: h.snippet,
      confidence: h.score,
      score: h.score,
      created_at: typeof h.created_at === 'number' ? toIso(h.created_at) : String(h.created_at),
    })),
    ...promptMemCosine.map((h) => ({
      source: 'prompt_memory_cosine' as RecallSource,
      id: h.id,
      snippet: h.snippet,
      confidence: h.score,
      score: h.score,
      created_at: String(h.created_at),
    })),
    ...docCosine.map((h) => ({
      source: 'doc_cosine' as RecallSource,
      id: h.id,
      snippet: h.snippet,
      confidence: h.score,
      score: h.score,
      created_at: String(h.created_at),
    })),
  ];

  // Map RRF namespaced ids back to full RecallResult objects.
  const byKey = new Map<string, RecallResult>();
  for (const r of allResults) {
    const k = nsKey(r.source, r.id);
    if (!byKey.has(k)) byKey.set(k, r);
  }

  return rrfResult
    .map((rankable) => {
      const original = byKey.get(rankable.id);
      if (!original) return null;
      return { ...original, score: rankable.score };
    })
    .filter((r): r is RecallResult => r !== null);
}
