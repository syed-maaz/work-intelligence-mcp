import Database from "better-sqlite3";
import { existsSync } from "node:fs";

export const TASK = {
  name: "reap-2026-08-06",
  date: "2026-08-06",
  staleRunningDays: 21,
  keepUnread: 4,
};

const MS_PER_DAY = 86400000;

/**
 * Resolve real column names for a table. PRAGMA table_info does not accept
 * bound parameters; table names here are application constants only.
 */
function resolveColumns(db, table) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`reap: unsafe table name '${table}'`);
  }
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
}

/**
 * dispatched_at is written as epoch milliseconds; older rows may be seconds.
 * Magnitude > 1e11 implies milliseconds.
 */
function toEpochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.abs(n) > 1e11 ? n : n * 1000;
}

export function parseStaleCutoff(nowMs, staleDays) {
  return nowMs - staleDays * MS_PER_DAY;
}

export function isStaleRunning(row, cutoffMs) {
  const dispatched = toEpochMs(row.dispatched_at);
  if (dispatched == null) return true;
  return dispatched < cutoffMs;
}

/**
 * Detect whether the status CHECK constraint accepts 'aborted'.
 * Some schemas constrain status to (pending,running,succeeded,failed,timed_out)
 * and reject 'aborted' — in that case the terminal state is 'failed' with the
 * reap reason recorded in error_text.
 */
export function allowedTerminalStatus(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subagent_dispatches'").get();
  const ddl = row?.sql ?? "";
  const re = /CHECK\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+IN\s*\(([^)]*)\)/gi;
  let m;
  let allowed = null;
  while ((m = re.exec(ddl)) !== null) {
    if (m[1] !== "status") continue;
    allowed = m[2].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    break;
  }
  if (!allowed) return "aborted";
  return allowed.includes("aborted") ? "aborted" : allowed.includes("failed") ? "failed" : "aborted";
}

/**
 * T1 — hang reap. Mark subagent_dispatches rows that are status='running' and
 * older than staleRunningDays as terminated.
 *
 * Column adaptation (schema reality: no reason/reaped_at columns today):
 *   reason   -> `reason` column if present, else `error_text`
 *   reaped_at -> `reaped_at` column if present, else `completed_at`
 * Status adaptation: 'aborted' where the CHECK constraint allows it,
 * otherwise 'failed' (schema-supported terminal state) with the reap reason
 * recorded in the reason column. If neither reason column exists, the abort
 * reason is not recorded (counted as a loud "NO TRACKING" line in the summary).
 */
export function planReapStaleRunning(db, nowMs, staleDays = TASK.staleRunningDays) {
  const cols = resolveColumns(db, "subagent_dispatches");
  const required = ["id", "status"];
  const missing = required.filter((c) => !cols.includes(c));
  if (missing.length > 0) {
    return { ok: false, reason: `missing column(s): ${missing.join(", ")}`, rows: [] };
  }

  const hasReason = cols.includes("reason") ? "reason" : cols.includes("error_text") ? "error_text" : null;
  const hasReapedAt = cols.includes("reaped_at") ? "reaped_at" : cols.includes("completed_at") ? "completed_at" : null;
  const statusValue = allowedTerminalStatus(db);
  const cutoffMs = parseStaleCutoff(nowMs, staleDays);
  const running = db.prepare("SELECT id, dispatched_at FROM subagent_dispatches WHERE status = 'running'").all();
  const stale = running.filter((row) => isStaleRunning(row, cutoffMs));
  const reapedAtValue = hasReapedAt ? nowMs : null;

  return {
    ok: true,
    rows: stale,
    columns: { reason: hasReason, reapedAt: hasReapedAt },
    reasonValue: `reaped-${TASK.date}-stale-running`,
    reapedAtValue,
    statusValue,
  };
}

/**
 * T2 — archive unread proactive_queue rows so remaining unread < keepUnread.
 *
 * Column adaptation (schema reality: no status/processed_at columns today):
 *   status -> `status` column if present ('queued' -> 'archived'), else the
 *             `read_at` column is the archive marker (NULL -> now).
 *   processed_at -> set when the column exists.
 * No rows are deleted, only status/marker transitions.
 */
export function planArchiveProactiveQueue(db, keepUnread = TASK.keepUnread) {
  const cols = resolveColumns(db, "proactive_queue");
  const required = ["id", "read_at"];
  const missing = required.filter((c) => !cols.includes(c));
  if (missing.length > 0) {
    return { ok: false, reason: `missing column(s): ${missing.join(", ")}`, rows: [] };
  }

  const hasStatus = cols.includes("status");
  const hasProcessedAt = cols.includes("processed_at");
  const nowText = new Date().toISOString().replace("T", " ").slice(0, 19);

  const unread = db.prepare("SELECT id FROM proactive_queue WHERE read_at IS NULL ORDER BY id ASC").all();
  const keepIds = new Set(unread.slice(-keepUnread).map((r) => r.id));
  const archive = unread.filter((r) => !keepIds.has(r.id));

  return {
    ok: true,
    rows: archive,
    keepIds: [...keepIds],
    columns: { status: hasStatus, processedAt: hasProcessedAt },
    nowText,
  };
}

function applyStaleRunning(db, plan, dryRun) {
  if (!plan.ok || plan.rows.length === 0) return 0;
  const reasonCol = plan.columns.reason;
  const reapedAtCol = plan.columns.reapedAt;

  const upd = db.transaction(() => {
    let n = 0;
    for (const row of plan.rows) {
      const sets = ["status = ?"];
      const args = [plan.statusValue];
      if (reasonCol) {
        sets.push(`${reasonCol} = ?`);
        args.push(plan.reasonValue);
      }
      if (reapedAtCol) {
        sets.push(`${reapedAtCol} = ?`);
        args.push(plan.reapedAtValue);
      }
      args.push(row.id);
      const info = db.prepare(`UPDATE subagent_dispatches SET ${sets.join(", ")} WHERE id = ?`).run(...args);
      n += info.changes;
    }
    return n;
  });
  if (dryRun) return 0;
  return upd();
}

function applyArchiveProactiveQueue(db, plan, dryRun) {
  if (!plan.ok || plan.rows.length === 0) return 0;

  const upd = db.transaction(() => {
    let n = 0;
    for (const row of plan.rows) {
      let sql;
      const args = [];
      if (plan.columns.status) {
        sql = "UPDATE proactive_queue SET status = 'archived'";
        if (plan.columns.processedAt) {
          sql += ", processed_at = ?";
          args.push(plan.nowText);
        }
        sql += " WHERE id = ?";
      } else {
        sql = "UPDATE proactive_queue SET read_at = ? WHERE id = ?";
        args.push(plan.nowText);
      }
      args.push(row.id);
      const info = db.prepare(sql).run(...args);
      n += info.changes;
    }
    return n;
  });
  if (dryRun) return 0;
  return upd();
}

export function countRunning(db) {
  const row = db.prepare("SELECT count(*) AS n FROM subagent_dispatches WHERE status = 'running'").get();
  return Number(row.n);
}

export function countUnread(db) {
  const row = db.prepare("SELECT count(*) AS n FROM proactive_queue WHERE read_at IS NULL").get();
  return Number(row.n);
}

export function openDb(dbPath, { readonly = false } = {}) {
  if (!existsSync(dbPath)) {
    throw new Error(`database missing: ${dbPath}`);
  }
  return new Database(dbPath, { readonly });
}

export function runReap(dbPath, { apply = false, nowMs = Date.now(), staleDays = TASK.staleRunningDays, keepUnread = TASK.keepUnread } = {}) {
  const db = openDb(dbPath, { readonly: !apply });
  try {
    const reapPlan = planReapStaleRunning(db, nowMs, staleDays);
    const queuePlan = planArchiveProactiveQueue(db, keepUnread);

    let before;
    let after;
    if (reapPlan.ok && queuePlan.ok) {
      before = { running: countRunning(db), unread: countUnread(db) };
      const reaped = apply ? applyStaleRunning(db, reapPlan, false) : 0;
      const archived = apply ? applyArchiveProactiveQueue(db, queuePlan, false) : 0;
      after = { running: apply ? countRunning(db) : before.running, unread: apply ? countUnread(db) : before.unread };
      const summary = {
        task: TASK.name,
        dryRun: !apply,
        before,
        after,
        reap: { ok: reapPlan.ok, reason: reapPlan.ok ? null : reapPlan.reason, targeted: reapPlan.rows.length, applied: reaped },
        queue: { ok: queuePlan.ok, reason: queuePlan.ok ? null : queuePlan.reason, targeted: queuePlan.rows.length, applied: archived, keptUnread: queuePlan.keepIds.length },
      };
      summarizeWarnings(summary, reapPlan, queuePlan);
      db.close();
      return summary;
    }

    before = null;
    after = null;
    const summary = {
      task: TASK.name,
      dryRun: !apply,
      before,
      after,
      reap: { ok: reapPlan.ok, reason: reapPlan.ok ? null : reapPlan.reason, targeted: reapPlan.ok ? reapPlan.rows.length : 0, applied: 0 },
      queue: { ok: queuePlan.ok, reason: queuePlan.ok ? null : queuePlan.reason, targeted: queuePlan.ok ? queuePlan.rows.length : 0, applied: 0, keptUnread: queuePlan.ok ? queuePlan.keepIds.length : 0 },
    };
    db.close();
    return summary;
  } catch (err) {
    db.close();
    throw err;
  }
}

function summarizeWarnings(summary, reapPlan, queuePlan) {
  if (reapPlan.ok && !reapPlan.columns.reason) {
    summary.warnings = ["subagent_dispatches has no reason/error_text column — abort reason NOT recorded"];
  }
  if (reapPlan.ok && reapPlan.statusValue !== "aborted") {
    summary.warnings = [...(summary.warnings ?? []), `status CHECK constraint rejects 'aborted' — using '${reapPlan.statusValue}' as terminal status`];
  }
  if (queuePlan.ok && !queuePlan.columns.status) {
    summary.warnings = [...(summary.warnings ?? []), "proactive_queue has no status column — read_at used as archive marker"];
  }
  if (summary.warnings) {
    summary.warnings.push("NO TRACKING — see warnings above");
  }
}
