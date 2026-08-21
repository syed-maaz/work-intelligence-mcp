/**
 * Cypher Session Inspector — read-only API helpers (slice 1 of 2).
 *
 *   GET /api/cypher/sessions      — list with filters / facets / pagination
 *   GET /api/cypher/sessions/:id  — single session + related outcomes + gap rows
 *
 * Surfaces the existing `cypher_sessions` + `cypher_outcomes` +
 * `plan_shape_gap_observed` tables. No schema changes; no INSERT/UPDATE/DELETE.
 *
 * The caller classification is a **derived heuristic** — there is no `caller`
 * column on cypher_sessions today. A future v73 schema delta would add a
 * real `caller TEXT` + `parent_session_id TEXT` so we don't have to guess.
 * Until then: rules below, also documented in the Caller chip tooltip on
 * the UI side.
 *
 * Refs:
 *   - Pattern: GET /api/cypher/plan-shape-gaps (web-server.js ~line 3513)
 *   - Schema: cypher_sessions / cypher_outcomes / plan_shape_gap_observed
 *     (see .schema in ~/.work-intelligence-mcp/data.db)
 *   - Build session: cyp_16ffaf32ba0e (2026-06-25)
 *
 * Slice-1 scope: backend + tests + smoke § 26. UI / CSV / docs are slice 2.
 */
// ────────────────────────────────────────────────────────────────────────────
// Schema constants — match what's actually in the DB today, not the prompt's
// description (which had two drifts: `in_progress` is not in the CHECK enum,
// and there's no `iterations` column on cypher_sessions).
// ────────────────────────────────────────────────────────────────────────────
/** CHECK enum on cypher_sessions.status as of v72. */
export const VALID_STATUS = ['pending', 'done', 'halted', 'asked_user'];
/** CHECK enum on cypher_sessions.outcome as of v72 (or NULL). */
export const VALID_OUTCOME = ['success', 'mixed', 'failed'];
/** Engine column — today only `loop` exists in the corpus; `pipeline` is EOL 2026-07-21. */
export const VALID_ENGINE = ['loop', 'pipeline'];
/** Posture taxonomy from ADR-038 (CHECK is NOT enforced at SQL today — the column is TEXT NULL). */
export const VALID_POSTURE = ['pr-review', 'bug-investigate', 'pm', 'generic'];
/** Caller buckets — derived, NOT a column. See classifyCaller() for rules. */
export const VALID_CALLER = ['human', 'cypher', 'automation', 'api'];
/** Sort columns whitelist — must match SELECT aliases so ORDER BY can resolve. */
export const VALID_SORT_COL = [
    'started_at',
    'duration_ms',
    'iterations',
    'total_tokens',
];
export const VALID_SORT_DIR = ['asc', 'desc'];
/** Pagination defaults. Mirrors plan-shape-gaps. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
// ────────────────────────────────────────────────────────────────────────────
// Caller classification — derived heuristic
//
// Today's `user` column distribution (from substrate audit 2026-06-25):
//   owner=720, smoke-24=23, smoke-22=10, owner-spike=4, budget-victim=3,
//   smoke=3, smoke-test-budget=1
//
// Rules (FIRST match wins):
//   1. automation — user ∈ {smoke, probe, test, monitor} OR
//                   user matches /^smoke[-_]/  OR /^probe[-_]/ OR
//                   user contains 'smoke-test' OR 'budget-victim' OR
//                   task_class === 'smoke' OR task_class matches /^smoke[-_]/
//   2. cypher    — reserved for D9 orchestrator (X-WI-Cypher-Parent header
//                  → parent_session_id column, both pending v73 schema delta).
//                  TODAY: never emitted.
//   3. human     — user ∈ HUMAN_USERS (maintainer identities)
//   4. api       — fallback (anything else, e.g. unknown user identities)
// ────────────────────────────────────────────────────────────────────────────
/** Known human-authenticated user identities. Add new humans here as they appear. */
const HUMAN_USERS = new Set(['owner', 'owner-spike']);
/** Pure classifier — takes (user, task_class) and returns a derived caller bucket. */
export function classifyCaller(input: { user?: string; task_class?: string }) {
    const user = (input.user ?? '').trim();
    const taskClass = (input.task_class ?? '').trim();
    // 1. automation — smoke/probe/test identity OR task_class
    if (user === 'smoke' ||
        user === 'probe' ||
        user === 'test' ||
        user === 'monitor' ||
        /^smoke[-_]/i.test(user) ||
        /^probe[-_]/i.test(user) ||
        /smoke[-_]?test/i.test(user) ||
        /budget[-_]victim/i.test(user) ||
        taskClass === 'smoke' ||
        /^smoke[-_]/i.test(taskClass)) {
        const reason = taskClass === 'smoke' || /^smoke[-_]/i.test(taskClass)
            ? `task_class='${taskClass}'`
            : `user='${user}'`;
        return { caller: 'automation', caller_hint: `automation identity (${reason})` };
    }
    // 2. cypher — reserved (D9). No way to detect today; column doesn't exist.
    // 3. human — known authenticated identities
    if (HUMAN_USERS.has(user)) {
        return {
            caller: 'human',
            caller_hint: user === 'owner-spike'
                ? 'human (Maaz, spike session)'
                : 'human (Maaz, wi-dispatch-stream.sh inferred)',
        };
    }
    // 4. api — fallback
    return {
        caller: 'api',
        caller_hint: `api (user='${user || '(none)'}', task_class='${taskClass || '(none)'}')`,
    };
}
/**
 * SQL fragment that matches the same automation rules as classifyCaller().
 * Returned as `(sqlExpr, params)` so the caller can wrap it in `AND (...)`
 * or `AND NOT (...)`. MUST stay in sync with classifyCaller() above — the
 * test suite asserts the two agree.
 */
function automationPredicate() {
    // SQLite LIKE is case-insensitive for ASCII; matches /^smoke[-_]/i etc.
    return {
        sql: `(
      s.user IN ('smoke','probe','test','monitor')
      OR s.user LIKE 'smoke-%' OR s.user LIKE 'smoke_%'
      OR s.user LIKE 'probe-%' OR s.user LIKE 'probe_%'
      OR s.user LIKE '%smoke-test%' OR s.user LIKE '%smoke_test%'
      OR s.user LIKE '%smoketest%'
      OR s.user LIKE 'budget-victim%' OR s.user LIKE 'budget_victim%'
      OR s.task_class = 'smoke'
      OR s.task_class LIKE 'smoke-%' OR s.task_class LIKE 'smoke_%'
    )`,
        params: [],
    };
}
function callerPredicate(caller: string) {
    const auto = automationPredicate();
    if (caller === 'automation')
        return auto;
    if (caller === 'human') {
        // human = known human user AND NOT automation
        const humansSql = `s.user IN (${[...HUMAN_USERS].map(() => '?').join(',')})`;
        return {
            sql: `(${humansSql} AND NOT ${auto.sql})`,
            params: [...HUMAN_USERS],
        };
    }
    if (caller === 'cypher') {
        // Reserved for D9 — emit a predicate that matches nothing.
        return { sql: '1 = 0', params: [] };
    }
    // api: NOT automation AND NOT a known human → "everything else"
    const humansSql = `s.user IN (${[...HUMAN_USERS].map(() => '?').join(',')})`;
    return {
        sql: `(NOT ${auto.sql} AND NOT (${humansSql}))`,
        params: [...HUMAN_USERS],
    };
}
/** Parse query params into a validated filter object. */
export function parseListParams(params: URLSearchParams) {
    const filters: {
        limit: number; offset: number;
        sort: { col: string; dir: string };
        q?: string; status?: string;
        outcome?: string; posture?: string;
        task_class?: string; user?: string;
        engine?: string; caller?: string;
        from?: string; to?: string;
    } = {
        limit: DEFAULT_LIMIT,
        offset: 0,
        sort: { col: 'started_at', dir: 'desc' },
    };
    const q = params.get('q');
    if (q !== null) {
        if (q.length > 200)
            return { ok: false, error: 'q_too_long' };
        filters.q = q;
    }
    const status = params.get('status');
    if (status !== null) {
        if (!VALID_STATUS.includes(status)) {
            return { ok: false, error: 'invalid_status', allowed: VALID_STATUS };
        }
        filters.status = status;
    }
    const outcome = params.get('outcome');
    if (outcome !== null) {
        if (outcome === 'null') {
            filters.outcome = 'null';
        }
        else if (!VALID_OUTCOME.includes(outcome)) {
            return { ok: false, error: 'invalid_outcome', allowed: [...VALID_OUTCOME, 'null'] };
        }
        else {
            filters.outcome = outcome;
        }
    }
    const posture = params.get('posture');
    if (posture !== null) {
        if (!VALID_POSTURE.includes(posture)) {
            return { ok: false, error: 'invalid_posture', allowed: VALID_POSTURE };
        }
        filters.posture = posture;
    }
    const taskClass = params.get('task_class');
    if (taskClass !== null) {
        if (taskClass.length > 80)
            return { ok: false, error: 'task_class_too_long' };
        filters.task_class = taskClass;
    }
    const user = params.get('user');
    if (user !== null) {
        if (user.length > 80)
            return { ok: false, error: 'user_too_long' };
        filters.user = user;
    }
    const engine = params.get('engine');
    if (engine !== null) {
        if (!VALID_ENGINE.includes(engine)) {
            return { ok: false, error: 'invalid_engine', allowed: VALID_ENGINE };
        }
        filters.engine = engine;
    }
    const caller = params.get('caller');
    if (caller !== null) {
        if (!VALID_CALLER.includes(caller)) {
            return { ok: false, error: 'invalid_caller', allowed: VALID_CALLER };
        }
        filters.caller = caller;
    }
    const from = params.get('from');
    if (from !== null) {
        if (Number.isNaN(Date.parse(from)))
            return { ok: false, error: 'invalid_from' };
        filters.from = from;
    }
    const to = params.get('to');
    if (to !== null) {
        if (Number.isNaN(Date.parse(to)))
            return { ok: false, error: 'invalid_to' };
        filters.to = to;
    }
    const limitRaw = params.get('limit');
    if (limitRaw !== null) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1)
            return { ok: false, error: 'invalid_limit' };
        if (n > MAX_LIMIT)
            return { ok: false, error: 'limit_too_large' };
        filters.limit = n;
    }
    const offsetRaw = params.get('offset');
    if (offsetRaw !== null) {
        const n = Number(offsetRaw);
        if (!Number.isInteger(n) || n < 0)
            return { ok: false, error: 'invalid_offset' };
        filters.offset = n;
    }
    const sortRaw = params.get('sort');
    if (sortRaw !== null) {
        const [colRaw, dirRaw = 'desc'] = sortRaw.split(':');
        if (!VALID_SORT_COL.includes(colRaw)) {
            return { ok: false, error: 'invalid_sort_col', allowed: VALID_SORT_COL };
        }
        if (!VALID_SORT_DIR.includes(dirRaw)) {
            return { ok: false, error: 'invalid_sort_dir', allowed: VALID_SORT_DIR };
        }
        filters.sort = { col: colRaw, dir: dirRaw };
    }
    return { ok: true, filters };
}
/**
 * Build a WHERE clause from filters. If `excludeDim` is set, the filter on
 * that dimension is dropped — used by facet computation so each facet shows
 * counts as if its own dimension wasn't constrained.
 */
function buildWhere(filters: any, excludeDim: string) {
    const conds = [];
    const params = [];
    if (filters.q !== undefined) {
        conds.push(`(s.session_id LIKE ? OR s.goal LIKE ?)`);
        const like = `%${filters.q}%`;
        params.push(like, like);
    }
    if (filters.status !== undefined && excludeDim !== 'status') {
        conds.push(`s.status = ?`);
        params.push(filters.status);
    }
    if (filters.outcome !== undefined && excludeDim !== 'outcome') {
        if (filters.outcome === 'null') {
            conds.push(`s.outcome IS NULL`);
        }
        else {
            conds.push(`s.outcome = ?`);
            params.push(filters.outcome);
        }
    }
    if (filters.posture !== undefined && excludeDim !== 'posture') {
        conds.push(`s.posture = ?`);
        params.push(filters.posture);
    }
    if (filters.task_class !== undefined && excludeDim !== 'task_class') {
        conds.push(`s.task_class = ?`);
        params.push(filters.task_class);
    }
    if (filters.user !== undefined && excludeDim !== 'user') {
        conds.push(`s.user = ?`);
        params.push(filters.user);
    }
    if (filters.engine !== undefined && excludeDim !== 'engine') {
        conds.push(`s.engine = ?`);
        params.push(filters.engine);
    }
    if (filters.caller !== undefined && excludeDim !== 'caller') {
        const cp = callerPredicate(filters.caller);
        conds.push(cp.sql);
        params.push(...cp.params);
    }
    if (filters.from !== undefined) {
        conds.push(`datetime(s.started_at) >= datetime(?)`);
        params.push(filters.from);
    }
    if (filters.to !== undefined) {
        conds.push(`datetime(s.started_at) < datetime(?)`);
        params.push(filters.to);
    }
    return {
        sql: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '',
        params,
    };
}
/**
 * SELECT columns + derived counts. Kept as a string so the same shape feeds
 * both the listSessions() query and the getSession() detail query.
 *
 * Note: `iterations` is derived from cypher_outcomes.metadata JSON
 * (most-recent verdict row per session). This is the authoritative number
 * because cypher_steps is NOT populated by the loop engine — only the
 * pipeline engine wrote step rows, and pipeline is EOL 2026-07-21. The loop
 * embeds iterations in `cypher_outcomes.signal_kind='verdict' → metadata.iterations`
 * (see src/services/cypher/loop.ts § persistOutcome).
 */
const SESSION_COLS = `
  s.session_id, s.goal, s.task_class, s.posture, s.user, s.engine, s.status, s.outcome,
  s.outcome_note, s.total_tokens, s.duration_ms, s.plan_shape_hash, s.prior_count,
  s.prior_success_rate, s.confirm_mode_requested, s.confirm_mode_used,
  s.allow_destructive, s.phase, s.chosen_skill, s.skill_actually_invoked,
  s.started_at, s.completed_at,
  (SELECT json_extract(co.metadata, '$.iterations')
     FROM cypher_outcomes co
    WHERE co.session_id = s.session_id AND co.signal_kind = 'verdict'
    ORDER BY co.created_at DESC LIMIT 1) AS iterations,
  (SELECT COUNT(*) FROM cypher_outcomes co
    WHERE co.session_id = s.session_id AND co.signal_kind = 'verdict') AS n_verdict_rows,
  (SELECT COUNT(*) FROM cypher_outcomes co
    WHERE co.session_id = s.session_id AND co.signal_kind = 'rerun') AS n_rerun_rows,
  (SELECT COUNT(*) FROM cypher_outcomes co
    WHERE co.session_id = s.session_id AND co.signal_kind = 'thumbs') AS n_thumbs_rows,
  (SELECT COUNT(*) FROM plan_shape_gap_observed g
    WHERE g.session_id = s.session_id) AS n_gap_observed
`;
function shapeRow(raw: any) {
    const cls = classifyCaller({ user: raw.user, task_class: raw.task_class });
    return {
        session_id: raw.session_id,
        goal: raw.goal,
        task_class: raw.task_class,
        posture: raw.posture,
        user: raw.user,
        engine: raw.engine,
        caller: cls.caller,
        caller_hint: cls.caller_hint,
        status: raw.status,
        outcome: raw.outcome,
        iterations: raw.iterations,
        duration_ms: raw.duration_ms,
        total_tokens: raw.total_tokens,
        plan_shape_hash: raw.plan_shape_hash,
        prior_count: raw.prior_count,
        prior_success_rate: raw.prior_success_rate,
        confirm_mode_used: raw.confirm_mode_used,
        started_at: raw.started_at,
        completed_at: raw.completed_at,
        n_verdict_rows: raw.n_verdict_rows,
        n_rerun_rows: raw.n_rerun_rows,
        n_thumbs_rows: raw.n_thumbs_rows,
        n_gap_observed: raw.n_gap_observed,
    };
}
/**
 * Compute one facet dimension's GROUP BY counts under the current filter set
 * MINUS that dimension's own filter (so the facet shows counts AS IF that
 * dimension weren't constrained — typical faceted-search semantics).
 *
 * For derived `caller`, we GROUP in JS by iterating raw (user, task_class)
 * pairs because the SQL doesn't carry the heuristic.
 */
function facetByColumn(db: any, filters: any, col: string) {
    const where = buildWhere(filters, col);
    const sql = `
    SELECT COALESCE(s.${col}, '(null)') AS value, COUNT(*) AS n
      FROM cypher_sessions s
      ${where.sql}
     GROUP BY s.${col}
     ORDER BY n DESC, value ASC
  `;
    const rows = db.prepare(sql).all(...where.params);
    return rows.map((r: any) => ({ value: r.value, n: Number(r.n) }));
}
function facetByCaller(db: any, filters: any) {
    const where = buildWhere(filters, 'caller');
    const sql = `
    SELECT s.user, s.task_class, COUNT(*) AS n
      FROM cypher_sessions s
      ${where.sql}
     GROUP BY s.user, s.task_class
  `;
    const rows = db.prepare(sql).all(...where.params);
    const buckets = new Map();
    for (const r of rows) {
        const { caller } = classifyCaller({ user: r.user, task_class: r.task_class });
        buckets.set(caller, (buckets.get(caller) ?? 0) + Number(r.n));
    }
    return [...buckets.entries()]
        .map(([value, n]) => ({ value, n }))
        .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}
/** Run the list query + facets. Throws on SQL error so the handler can 500. */
export function listSessions(db: any, filters: any) {
    const where = buildWhere(filters, null as any);
    const sortCol = filters.sort.col;
    const sortDir = filters.sort.dir.toUpperCase();
    // sortCol is whitelisted via VALID_SORT_COL — safe to interpolate.
    const orderBy = `ORDER BY ${sortCol} ${sortDir} NULLS LAST, s.session_id ASC`;
    const rowsSql = `
    SELECT ${SESSION_COLS}
      FROM cypher_sessions s
      ${where.sql}
      ${orderBy}
      LIMIT ? OFFSET ?
  `;
    const countSql = `SELECT COUNT(*) AS n FROM cypher_sessions s ${where.sql}`;
    const rawRows = db.prepare(rowsSql).all(...where.params, filters.limit, filters.offset);
    const countRow = db.prepare(countSql).get(...where.params);
    const total = Number(countRow?.n ?? 0);
    const rows = rawRows.map(shapeRow);
    return {
        rows,
        total,
        has_more: filters.offset + rows.length < total,
        facets: {
            by_status: facetByColumn(db, filters, 'status'),
            by_outcome: facetByColumn(db, filters, 'outcome'),
            by_posture: facetByColumn(db, filters, 'posture'),
            by_task_class: facetByColumn(db, filters, 'task_class'),
            by_user: facetByColumn(db, filters, 'user'),
            by_engine: facetByColumn(db, filters, 'engine'),
            by_caller: facetByCaller(db, filters),
        },
    };
}
/** Validate session_id shape early — keeps the LIKE-injection surface zero.
 *  Accepts the canonical `cyp_<hex>` shape AND smoke-fixture ids like
 *  `smk-26-foo` that the bridge smoke § 26 inserts and removes. */
export function isValidSessionId(s: string) {
    return /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(s);
}
/** Fetch one session + all related rows. Returns `not_found` cleanly. */
export function getSession(db: any, sessionId: string) {
    const rawSql = `
    SELECT ${SESSION_COLS}
      FROM cypher_sessions s
     WHERE s.session_id = ?
     LIMIT 1
  `;
    const raw = db.prepare(rawSql).get(sessionId);
    if (!raw)
        return { ok: false, status: 404, error: 'not_found' };
    const sessionRow = shapeRow(raw);
    const outcomes = db
        .prepare(`SELECT id, signal_kind, value, weight, metadata, created_by, created_at,
              halt_after_call_id, halt_requested_at, failure_pattern
         FROM cypher_outcomes
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC`)
        .all(sessionId);
    const gaps = db
        .prepare(`SELECT id, plan_shape_hash, posture, tool_sequence_json, goal, user,
              prior_count, prior_success_rate, iterations, verdict, status, created_at
         FROM plan_shape_gap_observed
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC`)
        .all(sessionId);
    return {
        ok: true,
        data: {
            session: sessionRow,
            outcomes,
            gap_observations: gaps,
            parent_session: null, // D9 placeholder
            children_sessions: [], // D9 placeholder
            caller: sessionRow.caller,
            caller_hint: sessionRow.caller_hint,
        },
    };
}
// ────────────────────────────────────────────────────────────────────────────
// HTTP route handlers — RouteHandler[] consumed by the EXTRACTED_ROUTES
// dispatcher in web-server.js.
// ────────────────────────────────────────────────────────────────────────────
import { json } from './_util.js';
import type { RouteHandler } from './_types.js';
const listRoute: RouteHandler = {
    method: 'GET',
    path: '/api/cypher/sessions',
    handle(_req, res, ctx, url) {
        const parsed = parseListParams(url.searchParams);
        if (!parsed.ok) {
            json(res, 400, { error: parsed.error, ...(parsed.allowed ? { allowed: parsed.allowed } : {}) });
            return;
        }
        try {
            const response = listSessions(ctx.db, parsed.filters);
            json(res, 200, response);
        }
        catch (err) {
            json(res, 500, { error: 'list_failed', detail: (err as any)?.message || String(err) });
        }
    },
};
const detailRoute: RouteHandler = {
    method: 'GET',
    path: '/api/cypher/sessions/:session_id',
    handle(_req, res, ctx, url) {
        const parts = url.pathname.split('/').filter(Boolean);
        const sessionId = parts[parts.length - 1] ?? '';
        if (!isValidSessionId(sessionId)) {
            json(res, 400, { error: 'invalid_session_id' });
            return;
        }
        try {
            const result = getSession(ctx.db, sessionId);
            if (!result.ok) {
                json(res, result.status ?? 500, { error: result.error });
                return;
            }
            json(res, 200, result.data);
        }
        catch (err) {
            json(res, 500, { error: 'detail_failed', detail: (err as any)?.message || String(err) });
        }
    },
};
export const cypherSessionsRoutes = [
    // ORDER MATTERS — :param routes must come AFTER literal-path routes that
    // share a prefix. The dispatcher walks the array linearly, first match wins.
    // (Today both have unique paths so the order is purely defensive.)
    listRoute,
    detailRoute,
];
//# sourceMappingURL=cypher-sessions.js.map