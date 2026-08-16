#!/usr/bin/env bash
# scripts/smoke-pm-realwork.sh — file real work cards, then interpret the ranking.
#
# Unlike smoke-pm-scenarios.sh (which asserts mechanical properties on
# synthetic inputs), this exercises the PM layer on ACTUAL work items from
# this session — audit blockers, ADR follow-ups, corpus needs, cleanup
# tasks. It prints the resulting backlog with reasons and asks: does this
# ordering make sense to a real engineer looking at their real day?
#
# Not a pass/fail smoke — a judgement scenario. Prints the /pm next output
# in the exact shape the user would see it, so the ranking is inspectable.

set -u

BRIDGE="${WI_BRIDGE:-http://localhost:3132}"
WI_DB_PATH="${WI_DB_PATH:-$HOME/.work-intelligence-mcp/data.db}"

hdr() { echo ""; echo "── $1 ──"; }
create() {  # $1=title  $2=goal  $3=intent  $4=prio  $5=effort  [$6=deps_json]
  local body
  body=$(jq -nc \
    --arg t "$1" --arg g "$2" --arg i "$3" \
    --argjson p "$4" --argjson e "$5" \
    --argjson d "${6:-null}" \
    '{title:$t, goal_text:$g, intent:$i, priority:$p, effort_points:$e}
      + (if $d == null then {} else {depends_on:$d} end)')
  curl -sS -X POST "$BRIDGE/api/board/tasks" \
    -H 'Content-Type: application/json' -d "$body" \
    | jq -r '.task.id'
}

# ── Cleanup old real-work cards from prior runs ───────────────────────────
sqlite3 "$WI_DB_PATH" "DELETE FROM tasks WHERE title LIKE 'RW-%';" 2>/dev/null || true

echo "═══════════════════════════════════════════════════════════════════"
echo "ADR-043 real-work test — 8 cards from THIS session's actual outputs"
echo "═══════════════════════════════════════════════════════════════════"

# ── 1. v98 BLOCKER-1: broken prior blend (audit-prompt-memory)  ───────────
# Reasoning: real BLOCKER on shipped code, gates enabling recognition,
# small diff (pass real task_class), high user impact. → prio 88, effort 2.
RW1=$(create \
  "RW-01 v98: fix broken prior blend (getEffectivePriors '*' partition)" \
  "getEffectivePriors(db, '*', …) treats '*' as a literal partition key; only wi-search has a '*' row so blend is a static 33% down-weight on every other skill. Either pass real task_class OR aggregate across task_classes. Audit finding BLOCKER-1." \
  "execute" 88 2)

# ── 2. v98 BLOCKER-2: 'abandoned' outcome mis-weighted ────────────────────
# Reasoning: real correctness bug, 15% of corpus affected, trivial fix,
# gates same thing as BLOCKER-1. → prio 82, effort 1, deps: none (independent).
RW2=$(create \
  "RW-02 v98: handle 'abandoned' outcome explicitly (not '?? 0.5')" \
  "OUTCOME_WEIGHT map missing key; 126 of 854 rows (15%) silently weighted as mixed. Add explicit key or filter abandoned rows from prompt_memory backfill. Audit finding BLOCKER-2." \
  "execute" 82 1)

# ── 3. paraphrase corpus (blocks flipping WI_STAGE1_ENABLED=1) ─────
# Reasoning: unblocks the S2 fix; needs to exist BEFORE ADR-042 AC-U1 is
# meaningful; user needs to write the corpus (LLM proposes but user owns);
# medium effort. → prio 75, effort 3.
# Depends on nothing structural — can be built independently.
RW3=$(create \
  "RW-03 build paraphrase corpus for v98 recognition (10 goals)" \
  "8-10 goals written fresh, NOT sampled from prompt_memory. Each maps to a known correct skill. Used to baseline word-overlap fallback + measure semantic-path recall. Blocks flipping WI_STAGE1_ENABLED=1." \
  "execute" 75 3)

# ── 4. ADR-042 v2 — resolve BLOCKER-1 (ADR-039 amendment) ─────────────────
# Reasoning: paper-only edit, sequences before ADR-042 code, doc work not
# code. → prio 70, effort 1.
RW4=$(create \
  "RW-04 ADR-042: add AMENDMENT NOTICE to ADR-039" \
  "ADR-042 reframes SCOPE as Stage 1 but ADR-039 remains Accepted with no supersede notice. Add AMENDMENT NOTICE to ADR-039 pointing at ADR-042 with a precise delta (what survives / what's superseded). Blocks ADR-042 → Accepted." \
  "execute" 70 1)

# ── 5. ADR-042 v2 — resolve BLOCKER-2 (doc_embeddings phantom source) ─────
# Reasoning: paper-only decision — demote or scope out. → prio 65, effort 1.
RW5=$(create \
  "RW-05 ADR-042: demote doc_embeddings to future ADR or scope-out" \
  "ADR-042 diagram lists doc_embeddings as F3 fan-out but it doesn't exist (0 grep hits). Either link to a future ADR that ships it, or drop from Phase 1 spec and note only prompt_memory + message_embeddings ship today." \
  "execute" 65 1)

# ── 6. ADR-044 renumber (housekeeping — blocks nothing but risks confusion)
# Reasoning: numbering collision from ADR-043 review. Renaming is safe but
# needs care (draft references). → prio 45, effort 1.
RW6=$(create \
  "RW-06 renumber .planning/drafts/adr-043-general-task-fallback → adr-044" \
  "Legacy draft (2026-07-13, GAP-003 Tier 3 topic — unrelated to PM Orch) shares number with shipped ADR-043. git mv the draft to adr-044 and update its cross-refs. Non-blocking but should resolve before either ADR advances toward Accepted." \
  "execute" 45 1)

# ── 7. Dogfood re-verify reminder ADR-043 → Accepted (2026-07-18) ─────────
# Reasoning: THE existing card, filed last turn. Just show it in the mix.
# It's already at prio=65, effort=1.

# ── 8. Brainstorm: ranker weight-tuning based on 1 week of pickup logs ────
# Reasoning: brainstorm because it's an idea; NOT priority=90 — a mistake
# a hasty user might make. Correct: prio 35 because it's speculative, no
# real data yet. → intent brainstorm, prio 35, effort 5.
RW8=$(create \
  "RW-08 idea: log every pickup rank_score to file, tune weights weekly" \
  "Once workers have picked 100+ real cards, we should have a log of (card_id, rank_score, reasons) and be able to run weight-adjustment experiments. Blocked on real usage data. Brainstorm — not a build item yet." \
  "brainstorm" 35 5)

# ── 9. Plan item: figure out how to make deps_penalty aware of e2e state
# Reasoning: real gap — deps only count 'done' as ready, but sometimes an
# e2e card is 'effectively' done for downstream purposes. plan-intent
# because it needs thinking before building. → prio 55, effort 3.
RW9=$(create \
  "RW-09 plan: decide if kanban_column='e2e' counts as satisfied dep" \
  "Ranker counts only kanban_column='done' as a satisfied dep. But an e2e card is substrate-complete pending user click. Should downstream cards start moving when the upstream lands in e2e, or wait for done? Real tradeoff — needs a decision, not a build." \
  "plan" 55 3)

# ── 10. A card with unmet dep (points at RW-01) — sinks properly? ─────────
# Reasoning: a hypothetical follow-up that depends on RW-01 landing.
# Realistic: "enable WI_STAGE1_ENABLED=1" depends on the two blockers.
RW10=$(create \
  "RW-10 flip WI_STAGE1_ENABLED=1 in .env + smoke:stage1" \
  "Once BLOCKER-1 (RW-01) and BLOCKER-2 (RW-02) are fixed AND paraphrase corpus (RW-03) is green, flip the env flag and re-run smoke-bridge §47. Depends on the two audit fixes + corpus." \
  "execute" 78 1 "[\"$RW1\",\"$RW2\",\"$RW3\"]")

echo ""
echo "── Filed cards ──"
echo "  RW-01 (v98 BLOCKER-1)    : $RW1  prio=88 effort=2 execute"
echo "  RW-02 (v98 BLOCKER-2)    : $RW2  prio=82 effort=1 execute"
echo "  RW-03 (paraphrase corpus): $RW3  prio=75 effort=3 execute"
echo "  RW-04 (ADR-039 amend)    : $RW4  prio=70 effort=1 execute"
echo "  RW-05 (ADR-042 doc-embed): $RW5  prio=65 effort=1 execute"
echo "  RW-06 (ADR-044 renumber) : $RW6  prio=45 effort=1 execute"
echo "  RW-08 (log+tune idea)    : $RW8  prio=35 effort=5 brainstorm"
echo "  RW-09 (e2e-as-dep plan)  : $RW9  prio=55 effort=3 plan"
echo "  RW-10 (flip flag)        : $RW10 prio=78 effort=1 execute deps=[RW-01,RW-02,RW-03]"

# ── /pm next — the moment of truth ────────────────────────────────────────
hdr "/pm next — what should I do first?"

curl -sS "$BRIDGE/api/board/backlog?limit=1" | jq '
  .backlog[0] | {
    id, title, intent, priority, effort_points,
    rank_score: (.rank_score | . * 100 | round / 100),
    why: (.reasons | map(select(.contribution != 0) | {
      signal, value, contribution: (.contribution * 100 | round / 100)
    }))
  }'

# ── /pm backlog top 10 — full context ─────────────────────────────────────
hdr "/pm backlog (top 10, execute-only default)"

curl -sS "$BRIDGE/api/board/backlog?limit=100" | jq --arg prefix "RW-" '
  [.backlog[] | select(.title | startswith($prefix))]
  | sort_by(-.rank_score)
  | .[:10]
  | map({
      pos: null,
      card: .id[-6:],
      title: (.title | .[:60]),
      prio: .priority,
      eff: .effort_points,
      score: (.rank_score * 100 | round / 100)
    })
  | to_entries
  | map(.value + {pos: (.key + 1)})'

# ── /pm backlog with intent=all (show plan + brainstorm too) ──────────────
hdr "/pm backlog intent=all — plan/brainstorm surface here"

curl -sS "$BRIDGE/api/board/backlog?limit=100&intent=all" | jq --arg prefix "RW-" '
  [.backlog[] | select(.title | startswith($prefix))]
  | sort_by(-.rank_score)
  | map({
      card: .id[-6:],
      intent: .intent,
      title: (.title | .[:55]),
      prio: .priority,
      score: (.rank_score * 100 | round / 100)
    })'

# ── Show what happens after RW-01 completes: unblocks RW-10 ───────────────
hdr "Simulate: RW-01 done → does RW-10 (which depends on it) surface?"

# Move RW-01 to done. But: the SQL trigger requires user_observed evidence
# — we can't move to done via API. Instead simulate by SETTING the depends_on
# to reference a card that IS already done in the live DB.
# Simpler simulation: PATCH RW-10 to clear its deps and re-rank.

BEFORE_RW10_SCORE=$(curl -sS "$BRIDGE/api/board/backlog?limit=100&scope=open" \
  | jq --arg id "$RW10" '.backlog[] | select(.id == $id) | .rank_score')
BEFORE_RW10_RANK=$(curl -sS "$BRIDGE/api/board/backlog?limit=100&scope=open" \
  | jq --arg id "$RW10" '[.backlog[] | .id] | index($id) // "-"')

echo "  BEFORE (deps unmet): RW-10 rank_score=$BEFORE_RW10_SCORE, position=$BEFORE_RW10_RANK"

# Directly satisfy deps by moving RW-01/02/03 to 'done' state in DB.
# This bypasses the DoD trigger (which is intentional: we're not marking
# a real card done, just simulating the ranker's response to dep completion).
for id in "$RW1" "$RW2" "$RW3"; do
  # We can't UPDATE kanban_column='done' (trigger blocks it), so instead
  # temporarily NULL the depends_on_json on RW-10 and re-rank.
  :
done
# Cleaner simulation: clear RW-10 deps
curl -sS -X PATCH "$BRIDGE/api/board/tasks/$RW10" \
  -H 'Content-Type: application/json' \
  -d '{}' > /dev/null 2>&1
# Actually just PATCH depends_on_json indirectly — the PATCH endpoint
# doesn't expose it. Use direct SQL.
sqlite3 "$WI_DB_PATH" "UPDATE tasks SET depends_on_json = NULL WHERE id = '$RW10';"

AFTER_RW10_SCORE=$(curl -sS "$BRIDGE/api/board/backlog?limit=100" \
  | jq --arg id "$RW10" '.backlog[] | select(.id == $id) | .rank_score')
AFTER_RW10_RANK=$(curl -sS "$BRIDGE/api/board/backlog?limit=100" \
  | jq --arg id "$RW10" '[.backlog[] | .id] | index($id) // "-"')

echo "  AFTER (deps cleared): RW-10 rank_score=$AFTER_RW10_SCORE, position=$AFTER_RW10_RANK"
echo ""
echo "  → Interpretation: score should jump from strongly negative"
echo "    (priority 78 - 300 deps_penalty) to positive (78 + age)."

# ── Realistic user override: bump RW-04 (ADR-039 amend) because it's a
# 1-hour doc edit that unblocks ADR-042 acceptance — do it before RW-03
# corpus. ────────────────────────────────────────────────────────────────
hdr "Simulate: user says 'bump RW-04, it's a 1-hour doc that unblocks 042'"

BEFORE_RW4_RANK=$(curl -sS "$BRIDGE/api/board/backlog?limit=100" \
  | jq --arg id "$RW4" '[.backlog[] | .id] | index($id)')
echo "  BEFORE bump: RW-04 at position $BEFORE_RW4_RANK"

curl -sS -X PATCH "$BRIDGE/api/board/tasks/$RW4" \
  -H 'Content-Type: application/json' \
  -d '{"priority": 92}' > /dev/null

AFTER_RW4_RANK=$(curl -sS "$BRIDGE/api/board/backlog?limit=100" \
  | jq --arg id "$RW4" '[.backlog[] | .id] | index($id)')
echo "  AFTER  bump: RW-04 at position $AFTER_RW4_RANK"

# ── User asks 'what should I do today' — should return top 3 that fit
# in a half-day's effort budget ──────────────────────────────────────────
hdr "Simulate: 'give me today's picks' — sum of effort <= 4 points"

curl -sS "$BRIDGE/api/board/backlog?limit=100" | jq --arg prefix "RW-" '
  [.backlog[] | select(.title | startswith($prefix))]
  | sort_by(-.rank_score)
  | reduce .[] as $t ({budget: 4, picks: []};
      if .budget >= ($t.effort_points // 0) then
        {budget: (.budget - ($t.effort_points // 0)), picks: (.picks + [$t])}
      else . end)
  | .picks
  | map({
      card: .id[-6:],
      title: (.title | .[:50]),
      prio: .priority,
      eff: .effort_points
    })'

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "Interpretation guide — is the ranking sensible?"
echo "══════════════════════════════════════════════════════════════════"
cat <<'EOF'
Expected ordering after all operations (roughly):
  1. RW-04 (bumped to 92)              — user override wins
  2. RW-01 (v98 BLOCKER-1 prio=88)     — real blocker, small effort
  3. RW-02 (v98 BLOCKER-2 prio=82)     — real blocker, tiny effort
  4. RW-10 (flip flag prio=78)         — deps cleared, unblocked
  5. RW-03 (corpus prio=75)            — medium effort, larger task
  6. RW-05 (ADR-042 docs prio=65)      — doc-only
  7. reminder (prio=65)                — dogfood reminder from earlier
  8. RW-09 (plan)                      — hidden by default (correct)
  9. RW-06 (renumber prio=45)          — housekeeping, low prio
 10. RW-08 (brainstorm)                — hidden by default (correct)

If today's-picks (budget=4) returns RW-04 + RW-01 + RW-02 that's
correct: three small blockers that fit a half-day. If it goes for a
single big-effort card that ranks higher on priority alone, the
formula needs a "packing" heuristic (future tuning).
EOF

echo ""
echo "── Cleanup ──"
CLEANED=$(sqlite3 "$WI_DB_PATH" "SELECT COUNT(*) FROM tasks WHERE title LIKE 'RW-%';")
sqlite3 "$WI_DB_PATH" "DELETE FROM tasks WHERE title LIKE 'RW-%';" 2>/dev/null
echo "  Cleaned $CLEANED real-work cards"
