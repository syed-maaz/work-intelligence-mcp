#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# smoke-pm-phase3.sh — ADR-043 Phase 3 (Shape A) hermetic smoke.
#
# Unlike smoke-pm.sh (which needs a running bridge with PM_ORCHESTRATION_ENABLED),
# this runs entirely against a throwaway in-memory DB via the compiled dist/,
# so it needs NO bridge and NO Anthropic calls. It asserts the substrate the
# Phase 3 ACs depend on:
#   - v100 migration widens cypher_sessions.outcome to admit 'captured_to_board'
#   - capturePmTicket files a non-execute card (tsk_ prefix, lands ready)
#   - execute-intent capture is rejected (routing error)
#   - AC-R2: captured card is NOT eligible for the BoardWorkerAgent pick filter
#   - PMAgent tick flags a stale card + no-ops when PM_AGENT_ENABLED != 1
#
# Exit non-zero on any failure.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

PASS=0; FAIL=0
pass() { echo "  ✓ PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ FAIL: $1"; FAIL=$((FAIL+1)); }

echo "═══════════════════════════════════════════════════"
echo "ADR-043 Phase 3 (Shape A) — hermetic smoke"
echo "═══════════════════════════════════════════════════"

# The whole check runs inside one node script so a single DB is threaded through.
OUT=$(node --input-type=module -e "
import Database from 'better-sqlite3';
import migrateV59 from './dist/db/migrations/v59_cypher_tables.js';
import migrateV75 from './dist/db/migrations/v75_d2_task_memory.js';
import migrateV76 from './dist/db/migrations/v76_d3_projects_table.js';
import migrateV77 from './dist/db/migrations/v77_d3_tasks_project_fk.js';
import migrateV81 from './dist/db/migrations/v81_d19_recurate_pending.js';
import migrateV90 from './dist/db/migrations/v90_adr040_tasks_kanban.js';
import migrateV91 from './dist/db/migrations/v91_adr040_outcome_evidence.js';
import migrateV92 from './dist/db/migrations/v92_adr040_subagent_dispatches.js';
import migrateV93 from './dist/db/migrations/v93_adr040_interaction_tokens.js';
import migrateV94 from './dist/db/migrations/v94_adr040_card_number.js';
import migrateV95 from './dist/db/migrations/v95_adr040_card_comments.js';
import migrateV97 from './dist/db/migrations/v97_adr040_task_stalled.js';
import migrateV98 from './dist/db/migrations/v98_prompt_memory.js';
import migrateV99 from './dist/db/migrations/v99_adr043_pm_layer.js';
import migrateV100 from './dist/db/migrations/v100_captured_to_board_outcome.js';
import { capturePmTicket, mapRefinedIntent } from './dist/services/cypher/task-memory.js';
import { validateRefinedGoal } from './dist/services/cypher/refined-goal-schema.js';
import { PMAgent } from './dist/intelligence/pm-agent.js';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
for (const m of [migrateV59,migrateV75,migrateV76,migrateV77,migrateV81,migrateV90,migrateV91,migrateV92,migrateV93,migrateV94,migrateV95,migrateV97,migrateV98,migrateV99,migrateV100]) m(db);

const line = (ok,msg) => console.log((ok?'OK':'NO')+' '+msg);

// 1. v100 widened the CHECK
const sql = db.prepare(\"SELECT sql FROM sqlite_master WHERE name='cypher_sessions'\").get().sql;
line(sql.includes('captured_to_board'), 'v100 widens outcome CHECK for captured_to_board');

// 2. captured_to_board is insertable
try {
  db.prepare(\"INSERT INTO cypher_sessions (session_id, goal, task_class, user, status) VALUES ('cyp_s','g','dispatch','maaz','done')\").run();
  db.prepare(\"UPDATE cypher_sessions SET outcome='captured_to_board' WHERE session_id='cyp_s'\").run();
  const r = db.prepare(\"SELECT outcome FROM cypher_sessions WHERE session_id='cyp_s'\").get();
  line(r.outcome==='captured_to_board', 'session close with outcome=captured_to_board accepted');
} catch (e) { line(false, 'session close captured_to_board threw: '+e.message); }

// 3. capturePmTicket files a non-execute card, lands ready, tsk_ prefix
const cap = capturePmTicket(db, { title:'Plan the migration', intent:'plan', priority:70, goal_text:'plan it' });
line(cap.id.startsWith('tsk_') && cap.kanban_column==='ready' && cap.intent==='plan', 'capturePmTicket files non-execute card in ready (tsk_ prefix)');

// 4. execute intent rejected
let threw=false;
try { capturePmTicket(db, { title:'x', intent:'execute' }); } catch { threw=true; }
line(threw, 'capturePmTicket rejects intent=execute (routing error)');

// 4b. AC-A1 vocabulary reconciliation (2026-07-17): the refiner's three
// deliberative intents now (a) VALIDATE in refined-goal-schema and (b) MAP to
// their capturable PM bucket. Before this, the refiner enum and mapRefinedIntent
// had ZERO overlap, so AC-A1 could never fire. This is the unit-level proof of
// the link the end-to-end capture depends on — no Anthropic call needed.
const minimalBrief = (intent) => ({
  intent, target: 't', constraints: [], success_criteria: ['done'],
  out_of_scope: [], linkage: { jira: [], prs: [], adrs: [], files: [] },
  expected_output_shape: 'brief', evidence_cited: [],
});
for (const v of ['brainstorm','plan','decide']) {
  const val = validateRefinedGoal(minimalBrief(v));
  line(val.ok, 'AC-A1 refined-goal validates intent='+v);
  line(mapRefinedIntent(v) === v, 'AC-A1 mapRefinedIntent('+v+') → '+v+' (capturable, not execute)');
}
// A doing-verb must still map to execute (no over-capture).
line(mapRefinedIntent('investigate') === 'execute', 'AC-A1 mapRefinedIntent(investigate) → execute (doing-verb dispatches)');

// 5. AC-R2 — captured card NOT eligible for worker pick filter
const eligible = db.prepare(\"SELECT id FROM tasks WHERE kanban_column='ready' AND blocked=0 AND stalled=0 AND intent='execute' AND id LIKE 'task_%'\").all().map(r=>r.id);
line(!eligible.includes(cap.id), 'AC-R2 captured card absent from worker pick filter');

// 6. PMAgent stall flag (20d-old card, 14d window)
const now = 1800000000000, DAY=86400000;
db.prepare('UPDATE tasks SET created_at=?, entered_column_at=?, last_touched=? WHERE id=?').run(now-20*DAY, now-20*DAY, now-20*DAY, cap.id);
process.env.PM_AGENT_ENABLED='1';
const agent = new PMAgent({ db, nowMs: now, stallMs: 14*DAY });
const tick = await agent.tick();
const stalledRow = db.prepare('SELECT stalled FROM tasks WHERE id=?').get(cap.id);
line(tick.stalled_flagged>=1 && stalledRow.stalled===1, 'PMAgent flags stale ready card (>14d)');

// 7. AC-A4 — disabled no-op
delete process.env.PM_AGENT_ENABLED;
const t2 = await (new PMAgent({ db })).tick();
line(t2.skipped==='disabled', 'AC-A4 PMAgent no-ops when PM_AGENT_ENABLED!=1');

db.close();
" 2>&1)

echo "$OUT" | while IFS= read -r ln; do
  case "$ln" in
    OK\ *) pass "${ln#OK }" ;;
    NO\ *) fail "${ln#NO }" ;;
    *) [ -n "$ln" ] && echo "    · $ln" ;;
  esac
done

# Recompute pass/fail from the captured output (while-loop ran in a subshell).
P=$(echo "$OUT" | grep -c '^OK ')
F=$(echo "$OUT" | grep -c '^NO ')
echo "═══════════════════════════════════════════════════"
if [ "$F" -eq 0 ] && [ "$P" -gt 0 ]; then
  echo "✓ ADR-043 Phase 3 smoke: $P passed, 0 failed"
  exit 0
else
  echo "✗ ADR-043 Phase 3 smoke: $P passed, $F failed"
  exit 1
fi
