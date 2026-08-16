#!/usr/bin/env bash
# dream-extract.sh — extract genuine human-typed messages from the last N hours
# of Claude Code session transcripts, as JSONL: {session, ts, text}.
#
# Part of the /dream nightly memory-consolidation feature. This is the INGEST
# step: it is pure and deterministic (no LLM, no network). The generate step
# feeds this output to a model to propose memory changes.
#
# SAFETY CONSTRAINT #3 (user-typed facts only): evidence for a dream proposal
# must come ONLY from what the human actually typed — never tool output, never
# assistant replies, never harness-injected content (task-notifications, admin
# blocks, system reminders, SDK/subagent driver prompts).
#
# The decisive discriminator is the transcript's own `promptSource` field:
#   typed  → human keystrokes at the prompt            (KEEP)
#   queued → human message sent while the agent was busy (KEEP — still human)
#   system → harness-injected (task-notification, hooks) (DROP)
#   sdk    → programmatic / headless / subagent driver   (DROP)
#   absent → tool_result array lines et al.              (DROP)
# We additionally require string content (typed lines always are) as a cheap
# double-check, and post-strip any embedded <system-reminder>/<admin> blocks a
# UserPromptSubmit hook may have appended to an otherwise-genuine message.
#
# Usage:
#   scripts/dream-extract.sh [HOURS] [PROJECT_DIR]
#     HOURS       lookback window, default 24
#     PROJECT_DIR dir of *.jsonl transcripts, default = this machine's WI project
set -euo pipefail

HOURS="${1:-24}"

command -v jq >/dev/null || { echo "dream-extract: jq not found" >&2; exit 1; }
[ -d "$PROJECT_DIR" ] || { echo "dream-extract: no project dir $PROJECT_DIR" >&2; exit 1; }

# BSD date (macOS) for the window boundary; GNU date fallback for portability.
if SINCE="$(date -u -v-"${HOURS}"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"; then :; else
  SINCE="$(date -u -d "${HOURS} hours ago" +%Y-%m-%dT%H:%M:%SZ)"
fi

shopt -s nullglob
files=("$PROJECT_DIR"/*.jsonl)
[ ${#files[@]} -gt 0 ] || { echo "dream-extract: no *.jsonl in $PROJECT_DIR" >&2; exit 0; }

for f in "${files[@]}"; do
  # Skip files whose mtime is older than the window entirely — cheap short-circuit.
  jq -rc --arg since "$SINCE" --arg sess "$(basename "$f" .jsonl)" '
    select(.type == "user")
    # human keyboard only — the whole safety spine is this one field
    | select(.promptSource == "typed" or .promptSource == "queued")
    | select((.message.content | type) == "string")
    | select((.timestamp // "") >= $since)
    # strip embedded harness blocks a hook may have appended to a real prompt
    | .message.content as $raw
    | ($raw
        | gsub("(?s)<system-reminder>.*?</system-reminder>"; "")
        | gsub("(?s)<admin>.*?</admin>"; "")
        | gsub("(?s)<task-notification>.*?</task-notification>"; "")
        | gsub("^\\s+|\\s+$"; "")) as $clean
    | select($clean | length > 0)
    | {session: $sess, ts: .timestamp, text: $clean}
  ' "$f" 2>/dev/null || true
done
