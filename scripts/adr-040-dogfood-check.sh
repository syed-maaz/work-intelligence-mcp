#!/usr/bin/env bash
# scripts/adr-040-dogfood-check.sh
#
# ADR-040 AC-R3: dogfood-window verifier. Reports whether ≥3 "real
# cards" have closed via the full user_observed path per the AC-R3
# quantitative definition:
#
#   (a) tasks.goal_text references a Jira key (regex [A-Z]+-\d+)
#       OR a PR number (regex #\d+)
#       OR an existing repo file path
#   (b) tasks.assigned_worker_id IS NOT NULL
#   (c) ≥1 panel_reviews row exists for the card
#   (d) closing time - creation time ≥ 4 hours
#   (e) verified_via='user_observed' on the closing outcome_evidence
#
# SQLite has no native regex — JS handles regex + fs.existsSync.
# Exits 0 when ≥3 real cards satisfy all 5 conditions; also emits
# failure_loop_rate_7d as an informational metric.
#
# Runs on-demand:
#   bash scripts/adr-040-dogfood-check.sh

set -u
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
WI_DB_PATH="${WI_DB_PATH:-$HOME/.work-intelligence-mcp/data.db}"

if [ ! -r "$WI_DB_PATH" ]; then
  echo "FATAL: WI_DB_PATH not readable: $WI_DB_PATH" >&2
  exit 2
fi

exec node - <<'NODE_EOF'
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DB = process.env.WI_DB_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const MIN_HOURS_OPEN = 4;
const REQUIRED_REAL_CARDS = 3;

const db = new Database(DB, { readonly: true });

// Pull every tasks row that reached 'done' with user_observed evidence.
const rows = db
  .prepare(`
    SELECT t.id, t.goal_text, t.assigned_worker_id, t.created_at, t.last_touched,
           oe.verified_via, oe.created_at AS oe_created_at,
           (SELECT COUNT(*) FROM panel_reviews pr WHERE pr.task_id = t.id) AS pr_count
      FROM tasks t
 LEFT JOIN outcome_evidence oe ON oe.task_id = t.id AND oe.verified_via = 'user_observed' AND oe.verdict = 'pass'
     WHERE t.kanban_column = 'done'
  `)
  .all();

const JIRA_KEY = /[A-Z]+-\d+/;
const PR_NUMBER = /#\d+/;

let realCount = 0;
const details = [];
for (const r of rows) {
  const goal = r.goal_text || '';
  const hasJira = JIRA_KEY.test(goal);
  const hasPr = PR_NUMBER.test(goal);
  const filePathMatch = goal.match(/[\w./_-]+\.(?:ts|tsx|js|jsx|md|sh|py|sql|json)/);
  const hasFile = !!(filePathMatch && existsSync(join(REPO_ROOT, filePathMatch[0])));
  const condA = hasJira || hasPr || hasFile;
  const condB = r.assigned_worker_id != null;
  const condC = r.pr_count > 0;
  const openHours = ((r.last_touched || r.oe_created_at || 0) - r.created_at) / (1000 * 3600);
  const condD = openHours >= MIN_HOURS_OPEN;
  const condE = r.verified_via === 'user_observed';
  const isReal = condA && condB && condC && condD && condE;
  if (isReal) realCount++;
  details.push({ id: r.id, goal: goal.slice(0, 60), condA, condB, condC, condD, condE, isReal });
}

// Failure-loop rate: rework re-entries / total closures in last 7d.
// Approximated via panel_reviews rejection count vs done count.
const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
const rework = db
  .prepare(`SELECT COUNT(*) AS n FROM panel_reviews WHERE verdict='rejected' AND started_at > ?`)
  .get(weekAgo);
const closures = db
  .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE kanban_column='done' AND last_touched > ?`)
  .get(weekAgo);
const failureLoopRate = closures.n > 0 ? rework.n / closures.n : 0;

console.log(`ADR-040 dogfood check — ${new Date().toISOString()}`);
console.log(`  real cards closed:       ${realCount} (need ≥${REQUIRED_REAL_CARDS})`);
console.log(`  failure_loop_rate_7d:    ${failureLoopRate.toFixed(3)}`);
console.log(`  total done cards seen:   ${rows.length}`);
if (details.length > 0 && realCount < REQUIRED_REAL_CARDS) {
  console.log('\n  Recent done cards (why they don\'t qualify):');
  for (const d of details.slice(0, 10)) {
    const failed = [];
    if (!d.condA) failed.push('a:no-jira/pr/file');
    if (!d.condB) failed.push('b:no-worker');
    if (!d.condC) failed.push('c:no-panel');
    if (!d.condD) failed.push('d:<4h');
    if (!d.condE) failed.push('e:no-user_observed');
    const tag = d.isReal ? '✓' : `✗ ${failed.join(',')}`;
    console.log(`    ${tag}  ${d.id}  ${d.goal}`);
  }
}
db.close();
process.exit(realCount >= REQUIRED_REAL_CARDS ? 0 : 1);
NODE_EOF
