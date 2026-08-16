/**
 * src/services/cypher/investigate.ts — ADR-036 PHASE-86-02-A (2026-06-16)
 * extended by PHASE-86-02-B (2026-06-19, palace probe) and
 * PHASE-86-02-C (2026-06-20, brain.context probe).
 *
 * The investigate stage's saved-context probes. Three probes:
 *   1. cypher_sessions (PHASE-86-02-A) — pure SQL, the cheapest signal.
 *   2. MemPalace search (PHASE-86-02-B) — best-effort semantic recall.
 *   3. Brain context (PHASE-86-02-C) — sprint, stuck Jiras, calendar
 *      agenda. Same payload Atlas / morning-brief / Web UI consume.
 *
 * **Why these probes.** PHASE-86-02 specifies three sources:
 * cypher_sessions, MemPalace, and /api/brain/context. The sessions
 * probe is the cheapest (one parameterized SELECT, no I/O beyond the
 * already-open SQLite connection) and the most directly useful (the
 * downstream "did Cypher already try this goal? did it work?" signal).
 * The palace probe layers semantic recall — past investigation drawers,
 * lessons-learned, decisions — that lexical session-goal matching
 * misses. The brain probe surfaces the user's *current* operational
 * context — sprint state, stuck Jiras, calendar agenda — that's
 * already aggregated by the bridge for Atlas / morning-brief / Web UI.
 *
 * **Boundaries this slice respects:**
 *   - No LLM call in any probe. Sessions is pure SQL; palace is one
 *     `mempalace_search` MCP call (vector search, deterministic);
 *     brain context is the in-process `buildBrainContext` aggregator
 *     (no HTTP self-call from inside the bridge — see "Why no HTTP"
 *     below). ADR-034 §Layer 1 invariant carries here: measurement is
 *     mechanical, not model-graded.
 *   - Best-effort: any failure logs to stderr (palace, brain) or
 *     surfaces in `errors` (sessions). The dispatch never fails
 *     because investigate could not enrich context. Per AC-86.2.2,
 *     palace timeout falls through silently — empty findings, no
 *     error string. Same shape carries to brain: timeout = silent.
 *   - Hard cap: ≤1 SELECT (sessions) + ≤1 palace search with a
 *     ~1500ms timeout + ≤1 brain context build with a ~1500ms
 *     timeout. Even pessimistically all three serialize within the
 *     PHASE-86-02 ≤5 tool calls / ≤2s budget (sessions is sub-ms
 *     and brain reads from the same db connection).
 *   - Goal-text filter: when the goal text contains a Jira-key or
 *     ADR-NNN token, bias the sessions probe toward sessions that
 *     mentioned the same token (cheap LIKE — no embedding). Palace
 *     uses the full goal text; brain doesn't filter on goal at all
 *     because its content is operational state, not goal-shaped.
 *
 * **Why no HTTP for the brain probe.** AC-86.2.3 says "fetches
 * /api/brain/context (already exists)." Literal HTTP from inside the
 * bridge to itself would re-enter the same `buildBrainContext` body
 * via a network hop, paying a port assumption + serialization cost
 * for no behavioral difference. The HTTP route is the right shape for
 * external callers (Atlas, Web UI, morning-brief). For investigate,
 * we call the underlying function directly. The fetcher is injectable
 * (see {@link probeBrainContext}) so HTTP-from-another-process can be
 * added later without changing the call signature.
 */

import type Database from 'better-sqlite3';
import type { PalaceClient } from '../../intelligence/palace-client.js';
import type { BrainContext } from '../brain/context-builder.js';

/**
 * One session "finding" the investigate stage surfaces. Shape matches
 * ADR-036 §D2.B `findings` output_kind contract: enough to render
 * without a follow-up fetch, but no payload bigger than ~200 bytes
 * per finding so the trace stays scannable.
 */
export interface SessionFinding {
  session_id: string;
  goal: string;
  task_class: string | null;
  outcome: 'success' | 'mixed' | 'failed' | null;
  chosen_skill: string | null;
  started_at: string;
  /** True when this session's goal text shares a Jira key / ADR ref with the new goal. */
  goal_token_match: boolean;
}

export interface SavedContext {
  /** Recent sessions for this user (most recent first). */
  recent_sessions: SessionFinding[];
  /** Most-similar palace drawers for this goal (PHASE-86-02-B). */
  palace_findings: PalaceFinding[];
  /** Operational state from the brain context (PHASE-86-02-C). */
  brain_findings: BrainFinding[];
  /** Indicates which probe sources contributed. */
  sources: { sessions: boolean; palace: boolean; brain: boolean };
  /** Per-source error logs for the trace. Empty when all probes succeeded. */
  errors: Record<string, string>;
}

/**
 * One palace "finding" the investigate stage surfaces. Mirrors the
 * `mempalace_search` row shape, trimmed to the fields useful at trace
 * altitude (≤500-byte payload per ADR-036 §D2.B output_kind contract).
 */
export interface PalaceFinding {
  drawer_id: string;
  wing: string;
  room: string;
  /** First ~200 chars of the drawer body — enough to render without a follow-up fetch. */
  content_preview: string;
  /** Cosine distance from the search vector, when MemPalace returned one. Lower = more similar. */
  distance: number | null;
}

/**
 * One brain "finding" the investigate stage surfaces. Per AC-86.2.3
 * the three load-bearing aspects are sprint state, stuck Jiras, and
 * the calendar agenda. We carry them as a flat list of typed entries
 * rather than the full BrainContext object so the trace stays
 * scannable and downstream stages don't have to re-shape.
 *
 * Each entry is small (≤200 bytes) and typed via `kind` so consumers
 * can branch without parsing. Future kinds can be added without
 * breaking existing readers — the discriminated-union shape is
 * additive.
 */
export interface BrainFinding {
  kind: 'sprint' | 'stuck_jira' | 'calendar' | 'open_investigation' | 'stale_warning';
  /** Human-scannable label (e.g. Jira key, sprint name, event title). */
  label: string;
  /** ≤200-char detail string — enough to render without a follow-up fetch. */
  detail: string;
}

/**
 * Extract the goal-shape tokens we filter on. Today: Jira keys /
 * `SAT-NNN` / `ADR-NNN` / `ADR-NNNN`. Cheap regex; same shape as
 * `auto-link.ts` so the two stays consistent.
 */
function extractGoalTokens(goal: string): string[] {
  const set = new Set<string>();
  // Jira-style: <ALPHA>-<digits>
  for (const m of goal.matchAll(/\b([A-Z][A-Z0-9_]+-\d+)\b/g)) {
    set.add(m[1]);
  }
  // ADR-NNN
  for (const m of goal.matchAll(/\bADR-\d{2,4}\b/g)) {
    set.add(m[0]);
  }
  return Array.from(set);
}

/**
 * Probe cypher_sessions for the user's last N dispatches, optionally
 * biased by goal-text token overlap.
 *
 * `limit` defaults to 5 per AC L1.1-A-01 (PHASE-86-02 §3.1.1) — small
 * enough to stay scannable in the trace, large enough to give plan
 * stage a real recency signal.
 *
 * Idempotent and side-effect-free. Failure modes:
 *   - SQLite error → return empty findings + record error in errors.sessions
 *   - User unknown / no sessions → return empty findings, no error
 */
export function probeRecentSessions(
  db: Database.Database,
  user: string,
  goal: string,
  limit: number = 5,
): { findings: SessionFinding[]; error?: string } {
  try {
    type Row = {
      session_id: string;
      goal: string;
      task_class: string | null;
      outcome: 'success' | 'mixed' | 'failed' | null;
      chosen_skill: string | null;
      started_at: string;
    };
    const rows = db.prepare(`
      SELECT session_id, goal, task_class, outcome, chosen_skill, started_at
      FROM cypher_sessions
      WHERE user = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(user, limit) as Row[];

    const tokens = extractGoalTokens(goal);
    const findings: SessionFinding[] = rows.map(r => ({
      session_id: r.session_id,
      goal: r.goal,
      task_class: r.task_class,
      outcome: r.outcome,
      chosen_skill: r.chosen_skill,
      started_at: r.started_at,
      goal_token_match: tokens.length > 0 && tokens.some(t => r.goal.includes(t)),
    }));

    return { findings };
  } catch (err) {
    return { findings: [], error: (err as Error).message };
  }
}

/**
 * The raw shape of a MemPalace search hit. The wire format varies
 * across MemPalace versions and we accept any of the documented
 * variants — same set `recall.ts` accepts so the two probes stay in
 * sync when MemPalace ships a new shape.
 */
interface RawPalaceHit {
  id?: string;
  drawer_id?: string;
  doc_id?: string;
  wing?: string;
  room?: string;
  text?: string;
  content?: string;
  snippet?: string;
  distance?: number;
  score?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Best-effort parse of MemPalace's JSON search response. Accepts either
 * a top-level array, `{results: [...]}`, or `{hits: [...]}`. Returns
 * `[]` on any parse failure — palace.search is best-effort and the
 * dispatch must not fail because of a malformed response.
 */
function parsePalaceRows(raw: string): RawPalaceHit[] {
  if (!raw || typeof raw !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed as RawPalaceHit[];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { results?: unknown; hits?: unknown };
    if (Array.isArray(obj.results)) return obj.results as RawPalaceHit[];
    if (Array.isArray(obj.hits)) return obj.hits as RawPalaceHit[];
  }
  return [];
}

/**
 * Default palace search timeout. ~1500ms keeps the investigate stage
 * comfortably inside the AC-86.2.4 ≤2s budget even with the
 * `recent_sessions` SQL also running. Surfaceable for tests.
 */
export const PALACE_SEARCH_TIMEOUT_MS = 1500;

/**
 * Probe MemPalace for goal-similar drawers via `mempalace_search`.
 *
 * Best-effort by AC-86.2.2:
 *   - `palace = null` / undefined → returns empty findings, no error
 *     (sources.palace stays false — probe was not run).
 *   - palace.search returns '' (MemPalace not configured / unreachable
 *     / underlying tool error) → empty findings, no error.
 *   - palace.search exceeds {@link PALACE_SEARCH_TIMEOUT_MS} → empty
 *     findings, no error ("falls through silently" per AC text).
 *   - palace.search throws → empty findings + error string in
 *     `errors.palace`. Logged for the trace; caller treats as a
 *     reachability fault per AC-86.2.7.
 *
 * Returns at most `limit` (default 5 per AC-86.2.2) findings.
 */
export async function probePalaceSearch(
  palace: PalaceClient | null | undefined,
  goal: string,
  limit: number = 5,
  timeoutMs: number = PALACE_SEARCH_TIMEOUT_MS,
): Promise<{ findings: PalaceFinding[]; error?: string; attempted: boolean }> {
  if (!palace) return { findings: [], attempted: false };
  if (!goal || !goal.trim()) return { findings: [], attempted: false };

  let raw: string;
  try {
    // Race against a timeout. On timeout, resolve to '' (treated as a
    // non-error empty result downstream — silent fall-through).
    raw = await Promise.race([
      palace.search(goal, undefined, limit),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), timeoutMs)),
    ]);
  } catch (err) {
    return { findings: [], error: (err as Error).message, attempted: true };
  }

  const rows = parsePalaceRows(raw).slice(0, limit);
  const findings: PalaceFinding[] = rows.map((r, idx) => {
    const drawer_id = String(r.drawer_id ?? r.id ?? r.doc_id ?? `palace-${idx}`);
    const wing = typeof r.wing === 'string' ? r.wing : extractMetaString(r.metadata, 'wing') ?? '';
    const room = typeof r.room === 'string' ? r.room : extractMetaString(r.metadata, 'room') ?? '';
    const body = String(r.snippet ?? r.text ?? r.content ?? '');
    return {
      drawer_id,
      wing,
      room,
      content_preview: body.slice(0, 200),
      distance: typeof r.distance === 'number' ? r.distance
        : typeof r.score === 'number' ? r.score
        : null,
    };
  });

  return { findings, attempted: true };
}

function extractMetaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const v = meta[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Default brain context fetch timeout. Matches the palace timeout —
 * AC-86.2.4 budget is ≤2s total; sessions is sub-ms; palace and brain
 * each get ~1500ms of headroom. Surfaceable for tests.
 */
export const BRAIN_CONTEXT_TIMEOUT_MS = 1500;

/**
 * The shape `probeBrainContext` accepts for fetching the BrainContext.
 * Default is `buildBrainContext` from context-builder.js (see
 * {@link probeBrainContext}). Tests inject canned implementations.
 */
export type BrainContextFetcher = (
  db: Database.Database,
  user: string,
  palace?: PalaceClient | null,
) => Promise<BrainContext>;

/**
 * Probe the brain context aggregator (`buildBrainContext`) for the
 * user's current operational state — sprint, stuck Jiras, calendar
 * agenda, open investigations, stale warnings.
 *
 * Best-effort by AC-86.2.3:
 *   - `fetcher = null` → returns empty findings, attempted=false (probe
 *     was disabled by the caller). Used as a kill-switch for cases
 *     where the caller knows brain is unavailable.
 *   - fetcher resolves → BrainContext is mapped to a flat list of
 *     `BrainFinding` rows. Sprint, stuck Jiras, calendar today, open
 *     investigations, and stale warnings are surfaced. The full
 *     7-field BrainContext stays inside the bridge — only the
 *     trace-altitude digest crosses into SavedContext.
 *   - fetcher exceeds {@link BRAIN_CONTEXT_TIMEOUT_MS} → empty
 *     findings, no error (silent fall-through, matches palace probe
 *     shape).
 *   - fetcher throws → empty findings + error string. Per AC-86.2.7
 *     the dispatch survives; the trace shows the failure for
 *     postmortem.
 *
 * Why not call /api/brain/context over HTTP. Inside the bridge, the
 * route handler imports `buildBrainContext` and calls it directly. A
 * self-HTTP hop adds port + serialization overhead with no behavioral
 * difference. The fetcher abstraction keeps the door open for an
 * out-of-process variant if the bridge ever splits.
 */
export async function probeBrainContext(
  db: Database.Database,
  user: string,
  fetcher: BrainContextFetcher | null,
  palace?: PalaceClient | null,
  timeoutMs: number = BRAIN_CONTEXT_TIMEOUT_MS,
): Promise<{ findings: BrainFinding[]; error?: string; attempted: boolean }> {
  if (!fetcher) return { findings: [], attempted: false };

  let ctx: BrainContext | null = null;
  try {
    ctx = await Promise.race([
      fetcher(db, user, palace),
      new Promise<BrainContext | null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch (err) {
    return { findings: [], error: (err as Error).message, attempted: true };
  }

  // Timeout path — fetcher didn't resolve in time. Silent fall-through
  // mirrors palace AC-86.2.2 wording.
  if (!ctx) return { findings: [], attempted: true };

  const findings: BrainFinding[] = [];

  if (ctx.sprint) {
    findings.push({
      kind: 'sprint',
      label: ctx.sprint.name,
      detail: `ends ${ctx.sprint.ends ?? 'unknown'} · ${ctx.sprint.fresh ? 'fresh' : 'stale'}`.slice(0, 200),
    });
  }

  for (const j of ctx.stuck_jiras ?? []) {
    findings.push({
      kind: 'stuck_jira',
      label: j.key,
      detail: `${j.days_stuck}d stuck${j.cluster ? ` · cluster=${j.cluster}` : ''}`.slice(0, 200),
    });
  }

  for (const e of ctx.calendar_today ?? []) {
    findings.push({
      kind: 'calendar',
      label: e.title.slice(0, 80),
      detail: `${e.time}${e.with ? ` · with ${e.with}` : ''}`.slice(0, 200),
    });
  }

  for (const inv of ctx.open_investigations ?? []) {
    findings.push({
      kind: 'open_investigation',
      label: inv.key,
      detail: `status=${inv.status}`.slice(0, 200),
    });
  }

  for (const w of ctx.stale_warnings ?? []) {
    findings.push({
      kind: 'stale_warning',
      label: w.slice(0, 80),
      detail: w.slice(0, 200),
    });
  }

  return { findings, attempted: true };
}

/**
 * Default brain-context fetcher — a thin wrapper around
 * `buildBrainContext` from context-builder.js. Lazy-imported so the
 * smoke harness (and other callers that supply their own fetcher) can
 * skip the module load entirely.
 */
let _defaultBrainFetcher: BrainContextFetcher | null = null;
async function defaultBrainFetcher(
  db: Database.Database,
  user: string,
  palace?: PalaceClient | null,
): Promise<BrainContext> {
  if (!_defaultBrainFetcher) {
    const mod = await import('../brain/context-builder.js');
    _defaultBrainFetcher = (innerDb, innerUser, innerPalace) =>
      mod.buildBrainContext(innerDb, innerUser, { palace: innerPalace ?? null });
  }
  return _defaultBrainFetcher(db, user, palace);
}

/**
 * Top-level investigate-stage entry point. Wires every available probe
 * into a single `SavedContext` payload. Call sites pass the full goal +
 * user; the helper does the filtering itself.
 *
 * Today: sessions probe (PHASE-86-02-A) + palace probe (PHASE-86-02-B)
 * + brain probe (PHASE-86-02-C). Each new probe extends `sources` and
 * may add per-source fields without changing the call signature here.
 *
 * Async because palace and brain probes are async. Sessions remain
 * synchronous internally; we run them first (sub-ms), then await
 * palace and brain in parallel — they share no state and `Promise.all`
 * keeps wall-clock at the slower of the two rather than the sum.
 *
 * `palace = null/undefined` keeps the palace probe a no-op.
 * `brainFetcher = null` does the same for brain. The default
 * brainFetcher (when the option is omitted) lazily imports and calls
 * `buildBrainContext` directly — no HTTP self-hop.
 */
export async function buildSavedContext(
  db: Database.Database,
  user: string,
  goal: string,
  palace?: PalaceClient | null,
  brainFetcher: BrainContextFetcher | null = defaultBrainFetcher,
): Promise<SavedContext> {
  const errors: Record<string, string> = {};

  const sessions = probeRecentSessions(db, user, goal);
  if (sessions.error) errors.sessions = sessions.error;

  // Palace + brain are independent; race their wall-clocks instead of
  // serializing. Both are best-effort and never throw out.
  const [palaceResult, brainResult] = await Promise.all([
    probePalaceSearch(palace, goal),
    probeBrainContext(db, user, brainFetcher, palace),
  ]);
  if (palaceResult.error) errors.palace = palaceResult.error;
  if (brainResult.error) errors.brain = brainResult.error;

  return {
    recent_sessions: sessions.findings,
    palace_findings: palaceResult.findings,
    brain_findings: brainResult.findings,
    sources: {
      sessions: !sessions.error,
      palace: palaceResult.attempted && !palaceResult.error,
      brain: brainResult.attempted && !brainResult.error,
    },
    errors,
  };
}
