#!/usr/bin/env bash
# scripts/smoke-bucket-scanner.sh
#
# Tier 2 smoke § 16 — fail-on-missing-bucket scanner.
#
# Scans every `messages.create({` / `messages.stream({` call site in
# src/services/, src/tools/, src/intelligence/, src/fetcher/, src/routes/,
# and web-server.js. For each call, asserts the call body either:
#   (a) spreads a value produced by bucketCallParams(...) — recognized as
#       any spread of a variable whose name matches /params|cfg|opts/i;
#   (b) is on the GRANDFATHER list at the top of this file.
#
# Known blind spots (excluded from grep scope — add them if ADR-031
# violations ever appear in those directories):
#   - tests/             (unit/integration tests mock create, not real calls)
#   - .planning/         (design docs, spike snapshots of old code)
#   - scripts/           (utility scripts, smoke test helpers)
#   - tools/wi-menubar/  (native macOS menubar app, separate project)
#
# A new analyzer method that hard-codes `model: 'claude-opus-4-8'` will
# fail this check loudly, forcing the developer to either use
# bucketCallParams (preferred) or add an explicit grandfather entry with
# justification.
#
# Migration plan: as existing call sites are migrated to bucketCallParams,
# delete their entries from GRANDFATHER. The grandfather list should
# shrink over time; never grow.
#
# Output: pass/fail lines; exit 1 if any unauthorized call site found.

set -u

# ── GRANDFATHER list ─────────────────────────────────────────────────────────
# Pre-existing call sites that legitimately use the legacy
# EXTRACTION_MODEL / DIGEST_MODEL constants. These will migrate to
# bucketCallParams in Tier 2 commit 2 (per the approved plan: "Grandfather
# + incremental migration"). Each entry is exact "file:line" matching the
# grep output of `messages.create({` lines.
#
# When you migrate one of these to bucketCallParams, DELETE its line here.
# When the list is empty, this scanner becomes pure "no new violations".
#
# Migration ledger (line numbers track the live source):
#   2026-05-31  C1  removed 5 fetch-bucket sites (analyzer.ts:detectActionItems
#               / summarizeContent / extractQuestions / extractCalendarFromMessages
#               / rankReviewers). Remaining analyzer.ts entries shifted by +62
#               lines due to model-config import + _bucketParams helper.
#   2026-05-31  C2  removed 4 digest-bucket sites (analyzer.ts:generateDigest
#               / buildNotebook / updateNotebook / buildMemberProfile). All
#               surviving entries shifted by +1 due to per-site `const params`
#               assignments inserted before each migrated messages.create.
#   2026-05-31  C3  removed 3 chat-bucket sites (analyzer.ts:chatWithContext
#               main + chatWithContext retry + answerQuestion). Decision A
#               from ADR-031: dropped the isComplex Haiku-vs-Sonnet split —
#               every chat reply now uses the single `chat` bucket. Lines
#               at and after analyzer.ts:1200 shifted -1.
#   2026-05-31  C4  removed remaining 8 analyzer.ts sites — 4 analyse-bucket
#               (reviewPR, generatePRDescription, proposeSolution,
#               analyzeCodeImpact) and 4 free functions (generatePreBrief,
#               scoreMessageSeverity, generateWeeklyReport, generateChatDigest)
#               which now route through a new freeFnParams() helper that
#               accepts an optional db+bucket. After C4, analyzer.ts is fully
#               bucket-aware; only correlation-agent / orchestrator-agent /
#               brain/anthropic-tool-use remain (cleared in C5).
#   2026-05-31  C5  removed all 5 remaining sites: correlation-agent.ts:201
#               (bucket='agents'), orchestrator-agent.ts:240/:276
#               (bucket='agents', plus the scoreMessageSeverity caller now
#               threads this.db so the registry drives that call too),
#               brain/anthropic-tool-use.ts:13 (was a JSDoc false positive,
#               rephrased to avoid the regex) and the live call at the
#               brainToolCall body which now accepts db+bucket; runDecision
#               passes 'decide'. **GRANDFATHER list now empty — every
#               messages.create / messages.stream in WI runs through the
#               per-bucket registry.**
GRANDFATHER=(
  # All call sites migrated 2026-05-31; new violations now fail § 16 hard.
)

# ── Setup ────────────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

is_grandfathered() {
  local key="$1"
  # The `${ARR[@]:-}` form is necessary here: macOS ships bash 3.x where
  # `"${EMPTY_ARRAY[@]}"` under `set -u` is treated as referencing an
  # unbound variable. The `:-` fallback lets the iteration produce zero
  # entries cleanly (correct behaviour now that the grandfather list is
  # empty — every messages.create site routes through bucketCallParams).
  for entry in "${GRANDFATHER[@]:-}"; do
    [ -z "$entry" ] && continue
    [ "$entry" = "$key" ] && return 0
  done
  return 1
}

uses_bucket_params() {
  # Check the 8 lines starting at the messages.create line for either
  #   - a `bucketCallParams(` call (the canonical entry point)
  #   - a `_bucketParams(` call (the AIAnalyzer private wrapper that
  #     routes through bucketCallParams while handling null-db fallback)
  #   - a `freeFnParams(` call (the analyzer.ts free-function wrapper
  #     that routes through bucketCallParams when given a db, else
  #     emits a legacy {model, max_tokens} pair)
  #   - a `.bucketParams(` call (AnalyzerCore.bucketParams — the method
  #     the extracted analyzer/* domain modules call via `core.bucketParams`;
  #     routes through bucketCallParams with the same null-db fallback)
  #   - a spread `...<var>` where <var> looks like params (heuristic)
  local file="$1"
  local lineno="$2"
  local end=$((lineno + 8))
  local snippet
  snippet=$(awk -v s="$lineno" -v e="$end" 'NR>=s && NR<=e' "$file" 2>/dev/null)
  if echo "$snippet" | grep -qE '(bucketCallParams|_bucketParams|bucketParams|freeFnParams)\('; then return 0; fi
  # Heuristic: a spread of a likely-params variable on the line right
  # before or right after messages.create({ — e.g.
  #   const params = bucketCallParams(...);
  #   await client.messages.create({ ...params, ... });
  # We also allow ...mcParams, ...cfg, ...opts, ...callOpts.
  if echo "$snippet" | grep -qE '\.\.\.\s*([a-zA-Z_]*[Pp]arams|cfg|opts|[a-zA-Z_]*Opts)\b'; then
    # Make sure that spread variable was set from one of the bucket-aware
    # entry points nearby — within 120 lines preceding — otherwise any
    # random spread would silently pass.
    #
    # Why 120? The Cypher tool-use loop (src/services/cypher/loop.ts) hoists
    # `const params = bucketCallParams(...)` to the top of a function and
    # then calls `messages.create({ ...params })` ~50 lines later inside a
    # while-loop body. A 30-line window false-flagged that legitimate site.
    # 120 lines is comfortable for any single-function hoist while still
    # being tight enough to catch a stray spread from an unrelated scope.
    local pre_start=$((lineno - 120))
    [ "$pre_start" -lt 1 ] && pre_start=1
    local pre_snippet
    pre_snippet=$(awk -v s="$pre_start" -v e="$lineno" 'NR>=s && NR<=e' "$file" 2>/dev/null)
    if echo "$pre_snippet" | grep -qE '(bucketCallParams|_bucketParams|bucketParams|freeFnParams)\('; then return 0; fi
  fi
  return 1
}

# ── Scan ─────────────────────────────────────────────────────────────────────
fail_count=0
pass_count=0

# Find every messages.create({ / messages.stream({ in our scope. -n for
# line numbers; --include scopes to live source.
matches=$(grep -rn -E 'messages\.(create|stream)\s*\(' \
  src/services/ src/tools/ src/intelligence/ src/fetcher/ src/routes/ web-server.js 2>/dev/null \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts' \
  | grep -v '\.d\.ts')

while IFS= read -r match; do
  file=$(printf "%s" "$match" | cut -d: -f1)
  lineno=$(printf "%s" "$match" | cut -d: -f2)
  key="$file:$lineno"

  if uses_bucket_params "$file" "$lineno"; then
    pass_count=$((pass_count + 1))
    continue
  fi

  if is_grandfathered "$key"; then
    pass_count=$((pass_count + 1))
    continue
  fi

  echo "  ✗ $key uses messages.create/stream without bucketCallParams (and not grandfathered)"
  echo "    fix: spread the result of bucketCallParams(db, '<bucket>') into the call object"
  echo "    see: .claude/rules/model-config.md or run: skills/wi-add-bucket"
  fail_count=$((fail_count + 1))
done <<< "$matches"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$fail_count" -eq 0 ]; then
  echo "  ✓ Bucket scanner: $pass_count call site(s) clean (incl. ${#GRANDFATHER[@]} grandfathered)"
  exit 0
else
  echo "  ✗ Bucket scanner: $fail_count NEW unauthorized call site(s); $pass_count clean"
  exit 1
fi
