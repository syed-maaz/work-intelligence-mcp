#!/usr/bin/env node
/**
 * scripts/repair-orphaned-captures.mjs — ADR-043 Phase A / Task A8.
 *
 * One-shot repair for the 2026-07-17 silent-fail bug: 3 sessions closed
 * `outcome='captured_to_board'` but `task_id IS NULL` and no corresponding
 * `tasks` row exists on the board. See ADR-043 §
 * "Audit note — AC-A1 wiring bug (2026-07-24)".
 *
 * What it does:
 *   For every cypher_sessions row where outcome='captured_to_board' AND
 *   task_id IS NULL:
 *     1. Parse `refined_goal` JSON, extract intent (must be non-execute) and
 *        target (used as card title).
 *     2. INSERT a `tasks` row mirroring what capturePmTicket() would have
 *        produced — posture='pm', kanban_column='ready' (default), priority=50,
 *        intent from refined_goal, goal_text=cypher_sessions.goal, and a fresh
 *        `tsk_<hex12>` id.
 *     3. UPDATE cypher_sessions.task_id = <new-id> for that session.
 *
 * DRY-RUN BY DEFAULT. Requires `--apply` to write.
 *
 * Usage:
 *   node scripts/repair-orphaned-captures.mjs --db /tmp/wi-repair-test.db
 *   node scripts/repair-orphaned-captures.mjs --db /tmp/wi-repair-test.db --apply
 *
 * Output shape:
 *   One line per repaired (or would-be-repaired) session:
 *     [repair] session=<sid> -> tasks.id=<tid> card_number=<n|null> intent=<i>
 *   Followed by a summary:
 *     repaired=N (dry-run) or repaired=N (applied)
 *
 * Safety:
 *   - Refuses to run without --db.
 *   - Refuses to touch $HOME/.work-intelligence-mcp/data.db unless explicitly
 *     passed AND --apply AND --i-know-this-is-live.
 *   - All writes wrap in a single transaction — either all 3 repairs land or
 *     nothing does. On any per-row error, the tx rolls back.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CAPTURABLE = new Set(['brainstorm', 'plan', 'decide']);
const LIVE_DB_ABS = path.resolve(process.env.HOME || '', '.work-intelligence-mcp/data.db');

function parseArgs(argv) {
  const out = { db: null, apply: false, iKnowLive: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--i-know-this-is-live') out.iKnowLive = true;
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: repair-orphaned-captures.mjs --db <path> [--apply] [--i-know-this-is-live]',
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function taskId() {
  const rand = createHash('sha256')
    .update(String(Date.now()) + Math.random().toString(36))
    .digest('hex')
    .slice(0, 12);
  return `tsk_${rand}`;
}

function extractDecision(refinedGoalJson, rawGoal) {
  if (!refinedGoalJson) return null;
  let parsed;
  try {
    parsed = JSON.parse(refinedGoalJson);
  } catch {
    return null;
  }
  const rawIntent =
    typeof parsed.intent === 'string' ? parsed.intent.trim().toLowerCase().split(/\s+/)[0] : null;
  if (!rawIntent || !CAPTURABLE.has(rawIntent)) return null;
  const target = typeof parsed.target === 'string' ? parsed.target.trim() : '';
  const title = (target || rawGoal || 'untitled').slice(0, 120);
  return { intent: rawIntent, title, goal_text: rawGoal ?? '' };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.db) {
    console.error('ERROR: --db <path> is required.');
    console.error('       Point it at /tmp/wi-repair-test.db (a fresh copy of the backup).');
    process.exit(2);
  }
  const absDb = path.resolve(args.db);
  if (absDb === LIVE_DB_ABS && !(args.apply && args.iKnowLive)) {
    console.error(
      `REFUSING to run against live DB (${absDb}) without both --apply and --i-know-this-is-live.`,
    );
    console.error('       Repair on a copy first: cp <live> /tmp/wi-repair-test.db');
    process.exit(3);
  }

  const db = new Database(absDb);
  db.pragma('foreign_keys = ON');

  const orphans = db
    .prepare(
      `SELECT session_id, goal, refined_goal
         FROM cypher_sessions
        WHERE outcome = 'captured_to_board'
          AND task_id IS NULL
        ORDER BY started_at ASC`,
    )
    .all();

  if (orphans.length === 0) {
    console.log('no orphaned captured_to_board sessions found — nothing to repair.');
    db.close();
    return;
  }

  const mode = args.apply ? 'applied' : 'dry-run';
  const now = Date.now();
  let repaired = 0;

  const applyRepair = db.transaction((rows) => {
    // Ensure projects table has 'wi' — capturePmTicket path relies on it.
    // The trigger + FK are already provisioned; we only insert if missing to
    // stay idempotent.
    const projRow = db.prepare(`SELECT id FROM projects WHERE id = 'wi'`).get();
    if (!projRow) {
      db.prepare(
        `INSERT INTO projects(id, name, created_at) VALUES ('wi','wi',?)`,
      ).run(now);
    }

    const insTask = db.prepare(`
      INSERT INTO tasks (
        id, title, posture, status, parent_task_id, external_ref,
        project, owner_user_id, created_at, last_touched,
        closed_at, closed_reason, git_branch, worktree_path, worktree_status,
        recurate_pending_at, goal_text, acceptance_text, kanban_column,
        kanban_order, priority, effort_points, intent
      ) VALUES (
        @id, @title, 'pm', 'open', NULL, NULL,
        'wi', 'maaz', @now, @now,
        NULL, NULL, NULL, NULL, NULL,
        NULL, @goal_text, NULL, 'ready',
        0, 50, NULL, @intent
      )
    `);
    const updSess = db.prepare(
      `UPDATE cypher_sessions SET task_id = COALESCE(task_id, ?) WHERE session_id = ?`,
    );
    const readCard = db.prepare(`SELECT card_number FROM tasks WHERE id = ?`);

    for (const row of rows) {
      const decision = extractDecision(row.refined_goal, row.goal);
      if (!decision) {
        console.error(
          `  skipped session=${row.session_id}: refined_goal missing/invalid or intent not capturable`,
        );
        continue;
      }
      const id = taskId();
      insTask.run({
        id,
        title: decision.title,
        now,
        goal_text: decision.goal_text,
        intent: decision.intent,
      });
      updSess.run(id, row.session_id);
      const card = readCard.get(id);
      console.log(
        `[repair] session=${row.session_id} -> tasks.id=${id} card_number=${card?.card_number ?? 'null'} intent=${decision.intent}`,
      );
      repaired += 1;
    }
  });

  const dryRun = (rows) => {
    for (const row of rows) {
      const decision = extractDecision(row.refined_goal, row.goal);
      if (!decision) {
        console.error(
          `  skipped session=${row.session_id}: refined_goal missing/invalid or intent not capturable`,
        );
        continue;
      }
      const previewId = taskId();
      // In dry-run, card_number won't be assigned. Show `null` for parity.
      console.log(
        `[repair] session=${row.session_id} -> tasks.id=${previewId} card_number=null intent=${decision.intent}`,
      );
      repaired += 1;
    }
  };

  if (args.apply) {
    try {
      applyRepair(orphans);
    } catch (err) {
      console.error('ERROR during repair transaction — rolled back:', err.message);
      db.close();
      process.exit(1);
    }
  } else {
    dryRun(orphans);
  }

  console.log(`repaired=${repaired} (${mode})`);
  db.close();
}

// Only run when invoked directly (not when imported for tests).
const invokedAs = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === invokedAs) {
  main();
}
