#!/usr/bin/env node
/**
 * Weekly metrics report (G4-METRICS) — the "measure before build" guard.
 *
 * Prints the 3-number weekly health signal plus the ADR-050 dispatch gate and
 * extra diagnostics. Read-only against the SQLite DB.
 *
 *   npm run metrics:weekly
 *   PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH" node scripts/weekly-metrics.js
 *
 * DATABASE_PATH env var overrides the default ${HOME}/.work-intelligence-mcp/data.db.
 *
 * Real-schema mapping (verified 2026-08-06 against the live DB):
 *   1. SESSIONS RUN     -> cypher_sessions.started_at in window.
 *                          NOTE: column stores BOTH epoch-ms floats (410 rows)
 *                          and ISO datetimes (1410 rows) — the parser handles both.
 *   2. BUGS CLOSED      -> tasks (kanban) cards that moved to closed in the window:
 *                          status='closed' AND closed_at in window, OR
 *                          kanban_column='done' AND entered_column_at in window
 *                          (max of the two — avoids double counting reconcile-lag).
 *                          Cross-checks: jira_transitions.to_status,
 *                          bug_resolutions.outcome, bugs.status ('resolved' count —
 *                          that table has NO status-change timestamp, so bugs is
 *                          not window-taggable — surfaced honestly, never inferred).
 *   3. QUERIES ANSWERED -> cypher_steps stage='tool_use' AND status='completed'
 *                          in window. There is NO tool_invocations / tool_calls /
 *                          animate_stats / message_stats table in the schema;
 *                          cypher_steps is the tool-call log.
 *   DISPATCH           -> subagent_dispatches (dispatched_at epoch-ms), grouped by
 *                          status; success rate surfaced against the ADR-050 M2
 *                          executor floor (>= 80%).
 *
 * Veto gate (docs/planning/notes/g4-veto-rule.md):
 *   sessions < 30/week AND bugs-closed < 1/week => VETO new build work for the
 *   week (maintenance/ops only). Two consecutive veto weeks => mandatory
 *   stand-down + orchestration re-plan. Metrics always come from this script —
 *   never hand-entered.
 *
 * Fail-loud policy:
 *   - Missing TABLE  -> graceful: reported as an explicit note, metric = 0.
 *   - Missing COLUMN -> throws "UNKNOWN COLUMN — update script: <table>.<col>".
 *   No silent zeros under either case.
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WINDOW_DAYS = 7;
export const ADR050_DISPATCH_FLOOR = 0.8;
export const VETO_SESSIONS_MIN = 30;
export const VETO_BUGS_MIN = 1;

const CLOSED_STATUSES = ['Completed', 'Resolved', 'Done'];
const RESOLVED_OUTCOMES = ['resolved', 'fixed', 'success'];

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function resolveDbPath() {
  return process.env.DATABASE_PATH || path.join(os.homedir(), '.work-intelligence-mcp', 'data.db');
}

/** For printing/reporting — $HOME redacted so pasted logs don't leak the OS username. */
export function displayDbPath(dbPath) {
  const home = os.homedir();
  return dbPath && dbPath.startsWith(home) ? dbPath.replace(home, '~') : dbPath;
}

export function hasTable(db, name) {
  if (!IDENT_RE.test(name)) return false;
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

export function hasColumn(db, table, column) {
  if (!IDENT_RE.test(table) || !IDENT_RE.test(column)) return false;
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);
}

/** Throws loudly on a missing column of an existing table; resolves false when
 *  the whole table is absent (caller should surface a MISSING TABLE note). */
export function tableColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  if (!hasColumn(db, table, column)) {
    throw new Error(`UNKNOWN COLUMN — update script: ${table}.${column}`);
  }
  return true;
}

export function isoTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** Parse a DB timestamp that is either an epoch-ms float/string or an ISO
 *  datetime ('YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM:SS(.mmm)Z'). ISO
 *  strings without an explicit zone are DB 'datetime(...)' UTC values, so the
 *  Z is appended before parsing (never assume local time). */
export function toEpochMs(value) {
  if (typeof value === 'number') return value > 1e11 ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    // Epoch-ms only — epoch-seconds (< ~1e11) are out of scope and would
    // misrender as 1970 if leaked through. Fail closed to NaN.
    return n > 1e11 ? n : NaN;
  }
  const withZone = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const hasZone = /([Zz]|[+-]\d{2}:\d{2})$/.test(withZone);
  const parsed = Date.parse(hasZone ? withZone : `${withZone}Z`);
  if (!Number.isFinite(parsed)) return NaN;
  return parsed > 1e11 ? parsed : NaN;
}

function countWhere(db, sql, ...params) {
  return db.prepare(sql).get(...params).c;
}

function maxTs(db, table, column) {
  if (!IDENT_RE.test(table) || !IDENT_RE.test(column)) return null;
  if (!hasTable(db, table)) return null;
  // Read raw column values and reduce in JS — SQLite max() across a mixed-type
  // INTEGER-affinity column returns the largest TEXT value in lexical sort,
  // hiding larger epoch-ms integers. toEpochMs normalises both forms.
  const rows = db.prepare(`SELECT ${column} AS m FROM ${table}`).all();
  let best = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    if (r.m === null || r.m === undefined) continue;
    const ms = toEpochMs(r.m);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = r.m;
    }
  }
  return best === null ? null : String(best);
}

function pctLabel(percentChange) {
  if (percentChange === null) return 'n/a (prev 0)';
  return `${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(1)}%`;
}

function gateLabel(pass) {
  return pass ? 'PASS' : 'FAIL';
}

export function collectSessions(db, startMs, endMs, notes = []) {
  const usable = tableColumn(db, 'cypher_sessions', 'started_at');
  if (!usable) {
    notes.push('MISSING TABLE — cypher_sessions absent; sessions-run = 0');
    return 0;
  }
  return db
    .prepare('SELECT started_at FROM cypher_sessions')
    .all()
    .reduce((acc, r) => {
      const ms = toEpochMs(r.started_at);
      return Number.isFinite(ms) && ms >= startMs && ms < endMs ? acc + 1 : acc;
    }, 0);
}

export function collectDispatch(db, startMs, notes = []) {
  if (!tableColumn(db, 'subagent_dispatches', 'dispatched_at') || !tableColumn(db, 'subagent_dispatches', 'status')) {
    notes.push('MISSING TABLE — subagent_dispatches absent; dispatch = n/a');
    return { succeeded: 0, timedOut: 0, failed: 0, failedReaped: 0, other: 0, total: 0, success: null, passesFloor: false, reapedAttributable: false };
  }
  const endMs = startMs + WINDOW_DAYS * 86400000;
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM subagent_dispatches
       WHERE dispatched_at >= ? AND dispatched_at < ? GROUP BY status`
    )
    .all(startMs, endMs);
  const tally = { succeeded: 0, timedOut: 0, failed: 0, failedReaped: 0, other: 0, reapedAttributable: false };

  // If error_text exists, break reaped (error_text LIKE 'reaped-%') out of the
  // 'failed' bucket so reaped-stale-children are NOT counted as genuine
  // failures against the ADR-050 floor (Reviewer-5 option b). Until an
  // 'aborted' status migration lands, reaped rows share the 'failed' status,
  // so they must be filtered here for the floor to stay truthful.
  let reapedRows = [];
  if (tableColumn(db, 'subagent_dispatches', 'error_text')) {
    tally.reapedAttributable = true;
    reapedRows = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM subagent_dispatches
         WHERE dispatched_at >= ? AND dispatched_at < ?
           AND status = 'failed' AND error_text LIKE 'reaped-%' GROUP BY status`
      )
      .all(startMs, endMs);
  }
  const reapedByStatus = {};
  for (const r of reapedRows) reapedByStatus[String(r.status)] = r.n;

  for (const r of rows) {
    const s = String(r.status);
    const reaped = reapedByStatus[s] ?? 0;
    if (s === 'succeeded') tally.succeeded += r.n;
    else if (s === 'timed_out') tally.timedOut += r.n;
    else if (s === 'failed') {
      tally.failed += r.n;
      tally.failedReaped += reaped;
    }
    else tally.other += r.n;
  }
  // Genuine failed = failed minus reaped — used for the ADR-050 floor.
  const failedGenuine = tally.failed - tally.failedReaped;
  tally.total = tally.succeeded + tally.timedOut + failedGenuine + tally.other;
  tally.success = tally.total ? tally.succeeded / tally.total : null;
  tally.passesFloor = tally.success !== null && tally.success >= ADR050_DISPATCH_FLOOR;
  return tally;
}

export function collectBugsClosed(db, startMs, endMs, notes = []) {
  const startIso = isoTs(startMs);
  const endIso = isoTs(endMs);
  let closedInWindow = null;
  let doneEnteredInWindow = null;
  let untaggedResolvedBugs = null;
  let jiraClosedInWindow = null;
  let bugResolutionsInWindow = null;

  if (tableColumn(db, 'tasks', 'status') && tableColumn(db, 'tasks', 'closed_at') &&
      tableColumn(db, 'tasks', 'kanban_column') && tableColumn(db, 'tasks', 'entered_column_at')) {
    // closed_at is a mixed-type INTEGER-affinity column (epoch-ms ints + ISO
    // text). Comparing it against ISO-text bounds coerces the ints to text and
    // produces wrong counts, so read every row and filter in JS via toEpochMs.
    closedInWindow = db
      .prepare(`SELECT closed_at AS m FROM tasks WHERE status = 'closed'`)
      .all()
      .reduce(
        (acc, r) => {
          const ms = toEpochMs(r.m);
          return Number.isFinite(ms) && ms >= startMs && ms < endMs ? acc + 1 : acc;
        },
        0,
      );
    doneEnteredInWindow = countWhere(
      db,
      `SELECT COUNT(*) AS c FROM tasks
       WHERE kanban_column = 'done' AND entered_column_at >= ? AND entered_column_at < ?`,
      startMs,
      endMs
    );
    if (closedInWindow === 0 && doneEnteredInWindow === 0) {
      const lastClosed = maxTs(db, 'tasks', 'closed_at');
      notes.push(`tasks kanban: 0 cards moved to closed in window (max closed_at=${lastClosed ? isoTs(toEpochMs(lastClosed)) : 'n/a'})`);
    }
  } else {
    notes.push('MISSING TABLE — tasks absent (no kanban board); bugs-closed = 0');
  }

  if (tableColumn(db, 'bugs', 'status')) {
    untaggedResolvedBugs = countWhere(db, `SELECT COUNT(*) AS c FROM bugs WHERE status = 'resolved'`);
    if (untaggedResolvedBugs > 0) {
      notes.push(
        `bugs table: ${untaggedResolvedBugs} rows status='resolved' but NO status-change timestamp column — ` +
          'window-tagging impossible; closed-tracking on bugs is NOT timestamped (count surfaced, never weekly number)'
      );
    }
  }

  if (tableColumn(db, 'jira_transitions', 'to_status') && tableColumn(db, 'jira_transitions', 'transitioned_at')) {
    const qs = CLOSED_STATUSES.map(() => '?').join(',');
    jiraClosedInWindow = countWhere(
      db,
      `SELECT COUNT(*) AS c FROM jira_transitions
       WHERE to_status IN (${qs}) AND transitioned_at >= ? AND transitioned_at < ?`,
      ...CLOSED_STATUSES,
      startIso,
      endIso
    );
    if (jiraClosedInWindow === 0) {
      const last = maxTs(db, 'jira_transitions', 'transitioned_at');
      if (last && last < startIso) {
        notes.push(
          `jira_transitions cold since ${last} (0 closed-to-${CLOSED_STATUSES.join('/')} in window) — ` +
            'Jira sync frozen, not counted as closures'
        );
      }
    }
  }

  if (tableColumn(db, 'bug_resolutions', 'outcome') && tableColumn(db, 'bug_resolutions', 'attempt_at')) {
    const qs = RESOLVED_OUTCOMES.map(() => '?').join(',');
    bugResolutionsInWindow = countWhere(
      db,
      `SELECT COUNT(*) AS c FROM bug_resolutions
       WHERE outcome IN (${qs}) AND attempt_at >= ? AND attempt_at < ?`,
      ...RESOLVED_OUTCOMES,
      startIso,
      endIso
    );
    if (bugResolutionsInWindow === 0 && hasTable(db, 'bug_resolutions')) {
      const ever = countWhere(db, `SELECT COUNT(*) AS c FROM bug_resolutions WHERE outcome IN (${qs})`, ...RESOLVED_OUTCOMES);
      notes.push(
        `bug_resolutions: ${ever} resolved attempts ever (last = ${maxTs(db, 'bug_resolutions', 'attempt_at') ?? 'n/a'}) — ` +
          'no resolution activity in window'
      );
    }
  }

  const lastScrape = maxTs(db, 'jira_issues', 'scraped_at');
  if (lastScrape && lastScrape < startIso) {
    notes.push(`jira_issues frozen since ${lastScrape} (last scrape) — issue-level Jira data stale`);
  }

  const count =
    closedInWindow === null && doneEnteredInWindow === null
      ? 0
      : Math.max(closedInWindow ?? 0, doneEnteredInWindow ?? 0);

  return {
    count,
    closedInWindow,
    doneEnteredInWindow,
    untaggedResolvedBugs,
    jiraClosedInWindow,
    bugResolutionsInWindow,
  };
}

export function collectQueriesAnswered(db, startMs, endMs, notes = []) {
  const absent = ['tool_invocations', 'tool_calls', 'animate_stats', 'message_stats'].filter(
    (t) => !hasTable(db, t)
  );
  if (absent.length) {
    notes.push(
      `no ${absent.join('/')} table in schema — cypher_steps (stage='tool_use'+status='completed') is the tool-call log used instead`
    );
  }
  if (!tableColumn(db, 'cypher_steps', 'stage') || !tableColumn(db, 'cypher_steps', 'status') ||
      !tableColumn(db, 'cypher_steps', 'created_at')) {
    notes.push('MISSING TABLE — cypher_steps absent; queries-answered = 0');
    return 0;
  }
  return countWhere(
    db,
    `SELECT COUNT(*) AS c FROM cypher_steps
     WHERE stage = 'tool_use' AND status = 'completed' AND created_at >= ? AND created_at < ?`,
    isoTs(startMs),
    isoTs(endMs)
  );
}

export function collectExtras(db, startMs, endMs, notes = []) {
  let proactiveUnread = null;
  let errorLogsInWindow = null;
  if (tableColumn(db, 'proactive_queue', 'read_at')) {
    proactiveUnread = countWhere(db, `SELECT COUNT(*) AS c FROM proactive_queue WHERE read_at IS NULL`);
  } else {
    notes.push('MISSING TABLE — proactive_queue absent; unread = n/a');
  }
  if (tableColumn(db, 'error_logs', 'occurred_at')) {
    errorLogsInWindow = countWhere(
      db,
      'SELECT COUNT(*) AS c FROM error_logs WHERE occurred_at >= ? AND occurred_at < ?',
      isoTs(startMs),
      isoTs(endMs)
    );
  } else {
    notes.push('MISSING TABLE — error_logs absent; error count = n/a');
  }
  return { proactiveUnread, errorLogsInWindow };
}

export function collectMetrics(db, { now = new Date(), windowDays = WINDOW_DAYS } = {}) {
  const windowMs = Math.max(1, Math.round(windowDays)) * 86400000;
  const windowEndMs = now.getTime();
  const windowStartMs = windowEndMs - windowMs;
  const notes = [];

  const sessionsCount = collectSessions(db, windowStartMs, windowEndMs, notes);
  const prevCount = collectSessions(db, windowStartMs - windowMs, windowStartMs, notes);
  const sessions = {
    count: sessionsCount,
    prevCount,
    percentChange: prevCount === 0 ? null : ((sessionsCount - prevCount) / prevCount) * 100,
  };

  const bugsClosed = collectBugsClosed(db, windowStartMs, windowEndMs, notes);
  const queriesAnswered = collectQueriesAnswered(db, windowStartMs, windowEndMs, notes);
  const dispatch = collectDispatch(db, windowStartMs, notes);
  const extra = collectExtras(db, windowStartMs, windowEndMs, notes);

  const veto = {
    sessionsOk: sessionsCount >= VETO_SESSIONS_MIN,
    bugsOk: bugsClosed.count >= VETO_BUGS_MIN,
  };
  veto.active = !veto.sessionsOk && !veto.bugsOk;

  return {
    windowStartMs,
    windowEndMs,
    sessions,
    bugsClosed,
    queriesAnswered,
    dispatch,
    extra,
    veto,
    notes,
  };
}

export function renderReport(result, dbPath) {
  const fmt = (ms) => isoTs(ms).slice(0, 10);
  const lines = [];
  lines.push('=== WEEKLY METRICS (measure-first gate, G4) ===');
  lines.push(`db:      ${displayDbPath(dbPath)}`);
  lines.push(`window:  ${fmt(result.windowStartMs)} .. ${fmt(result.windowEndMs)} (${WINDOW_DAYS}d)`);
  lines.push('');

  lines.push(
    `1. SESSIONS RUN     ${String(result.sessions.count).padStart(5)}   (prev 7d: ${result.sessions.prevCount}, Δ ${pctLabel(
      result.sessions.percentChange
    )})`
  );
  lines.push(
    `2. BUGS CLOSED      ${String(result.bugsClosed.count).padStart(5)}   (tasks kanban cards moved to closed)`
  );
  lines.push(
    `   [closed_at=${result.bugsClosed.closedInWindow ?? 'n/a'}  done-entered=${result.bugsClosed.doneEnteredInWindow ?? 'n/a'}  jira=${result.bugsClosed.jiraClosedInWindow ?? 'n/a'}  bug_resolutions=${result.bugsClosed.bugResolutionsInWindow ?? 'n/a'}]`
  );
  lines.push(
    `3. QUERIES ANSWERED ${String(result.queriesAnswered).padStart(5)}   (cypher_steps tool_use+completed)`
  );
  lines.push('');

  const d = result.dispatch;
  const successLabel = d.success === null ? 'n/a' : `${(d.success * 100).toFixed(1)}%`;
  const reapedNote = d.failedReaped > 0
    ? ` (reaped=${d.failedReaped}; genuine=${d.failed - d.failedReaped}; floor on genuine only)`
    : '';
  lines.push(
    `DISPATCH             total ${d.total} — succeeded ${d.succeeded} / timed_out ${d.timedOut} / failed ${d.failed} (reaped ${d.failedReaped}) / other ${d.other}`
  );
  lines.push(
    `   ADR-050 M2 floor    >= ${(ADR050_DISPATCH_FLOOR * 100).toFixed(0)}% success — measured ${successLabel} — ${gateLabel(
      d.passesFloor
    )}${reapedNote}`
  );
  lines.push('');

  const v = result.veto;
  lines.push(
    `VETO GATE            sessions>=${VETO_SESSIONS_MIN}: ${v.sessionsOk ? 'YES' : 'NO'} (${result.sessions.count})  |  bugs-closed>=${VETO_BUGS_MIN}: ${v.bugsOk ? 'YES' : 'NO'} (${result.bugsClosed.count})`
  );
  lines.push(
    `   => ${v.active ? 'VETO ACTIVE — new build work blocked (maintenance/ops only)' : 'no veto — build allowed'}`
  );
  lines.push('');

  const e = result.extra;
  lines.push('EXTRAS');
  lines.push(
    `   proactive_queue unread: ${e.proactiveUnread ?? 'n/a'} | error_logs in window: ${e.errorLogsInWindow ?? 'n/a'}`
  );
  lines.push('');

  if (result.notes.length) {
    lines.push('NOTES');
    for (const n of result.notes) lines.push(`   - ${n}`);
  }
  return lines.join('\n');
}

export function main() {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath, { readonly: true });
  try {
    process.stdout.write(renderReport(collectMetrics(db), dbPath) + '\n');
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}