#!/usr/bin/env bash
# scripts/wi-dispatch-stream.sh — SSE-as-one-shot wrapper around POST /api/wi/dispatch/stream
#
# Routes Cypher dispatches through the ADR-037 tool-use loop (runLoop in
# src/services/cypher/loop.ts) instead of the legacy 9-stage pipeline (runCypher
# in run.ts). Replaces the non-streaming `curl POST /api/wi/dispatch` pattern
# in .claude/rules/cypher-discipline.md and skills/wi-router/SKILL.md so that
# the canonical discipline + /wi surfaces exercise the loop end-to-end.
#
# Why a wrapper rather than changing /api/wi/dispatch's body to call runLoop:
# preserves ADR-036 D9's response-shape contract for external non-streaming
# callers; doesn't touch server code; lets us roll out per-surface.
#
# CONTRACT (stdout) — env-var-shell-style, per scripts/cost-compare.sh convention:
#   session_id="cyp_..."
#   verdict="success"        # one of success | mixed | failed | halted | abandoned | rejected_non_interactive
#   surface="..."            # the final assistant text (multi-line, shell-quoted)
#   iterations="N"           # tool_calls.length from LoopResult
#   duration_ms="1234"       # wallclock from LoopResult
#   engine="loop"            # from the engine event (always 'loop' on post-Phase-6 dispatches)
#
# Other SSE events relay to stderr live, prefixed [event: name] — so a Bash
# tool consumer (Claude Code) can watch the loop think.
#
# EXIT CODES:
#   0  clean — `event: done` arrived, all six env vars populated
#   1  loop emitted `event: error`
#   2  bridge unreachable (curl connection failure)
#   3  timeout — no `event: done` within --max-time seconds
#   4  bad arguments
#   5  loop asked for confirmation (`event: confirm_required`) — retry with
#      --confirm-mode auto (non-interactive discipline) or use /wi (interactive)
#
# USAGE:
#   bash scripts/wi-dispatch-stream.sh \
#     --goal "<one sentence>" \
#     [--task-class <class>] \
#     [--user <name>] \
#     [--confirm-mode interactive|auto|reject] \
#     [--dispatch-source user|smoke|test|agent] \
#     [--max-time <seconds>]
#
# ENV:
#   BRIDGE_URL  default http://localhost:3132 (matches scripts/smoke-killswitch.sh:54)

set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3132}"

# Defaults
goal=""
task_class="dispatch"
user="maaz"
confirm_mode="interactive"
max_time="90"
dispatch_source="user"

# ── argparse ──────────────────────────────────────────────────────────────────
usage() {
  cat >&2 <<'USAGE'
usage: wi-dispatch-stream.sh --goal "<text>" [--task-class <class>] [--user <name>] [--confirm-mode interactive|auto|reject] [--dispatch-source user|smoke|test|agent] [--max-time <seconds>]

Routes a Cypher dispatch through the ADR-037 tool-use loop via SSE.
On success, prints six env-var-shell-style lines on stdout (session_id, verdict, surface, iterations, duration_ms, engine).
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --goal)             goal="${2:-}"; shift 2 ;;
    --task-class)       task_class="${2:-}"; shift 2 ;;
    --user)             user="${2:-}"; shift 2 ;;
    --confirm-mode)     confirm_mode="${2:-}"; shift 2 ;;
    --dispatch-source)  dispatch_source="${2:-}"; shift 2 ;;
    --max-time)         max_time="${2:-}"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) printf 'error: unknown argument: %s\n' "$1" >&2; usage; exit 4 ;;
  esac
done

if [ -z "$goal" ]; then
  printf 'error: --goal is required\n' >&2
  usage
  exit 4
fi

case "$confirm_mode" in
  interactive|auto|reject) ;;
  *) printf 'error: --confirm-mode must be one of: interactive | auto | reject (got: %s)\n' "$confirm_mode" >&2; exit 4 ;;
esac

case "$dispatch_source" in
  user|smoke|test|agent) ;;
  *) printf 'error: --dispatch-source must be one of: user | smoke | test | agent (got: %s)\n' "$dispatch_source" >&2; exit 4 ;;
esac

# ── build request body (python3 to escape JSON safely — matches smoke-bridge.sh idiom) ──
body=$(GOAL="$goal" TASK_CLASS="$task_class" USER="$user" CONFIRM_MODE="$confirm_mode" DISPATCH_SOURCE="$dispatch_source" \
  python3 -c '
import json, os
print(json.dumps({
  "goal": os.environ["GOAL"],
  "task_class": os.environ["TASK_CLASS"],
  "user": os.environ["USER"],
  "confirm_mode": os.environ["CONFIRM_MODE"],
  "dispatch_source": os.environ["DISPATCH_SOURCE"],
}))')

# ── bridge liveness pre-check (separate exit code for unreachable) ────────────
if ! curl -fsS -m 3 -o /dev/null "${BRIDGE_URL}/api/status" 2>/dev/null; then
  printf 'error: bridge unreachable at %s\n' "$BRIDGE_URL" >&2
  exit 2
fi

# ── capture the SSE stream + relay events to stderr live ──────────────────────
# Matches the smoke-bridge.sh § 24 idiom: curl -fsS -N --max-time N captures the
# whole stream as one blob (SSE keeps the connection open until done/error/timeout),
# stderr relay happens after the fact via re-parse. We don't tee live because the
# blob-capture pattern is what the rest of the codebase uses; trade-off is stderr
# events arrive bunched at the end rather than streaming, but the wall-clock is
# identical and the audit story is the same.
#
# || true preserves the captured-so-far body if curl times out (so we can still
# emit a meaningful error). The 2>/dev/null on curl suppresses connection-error
# noise; the bridge-liveness check above is the real gate.
stream=$(curl -fsS -N -X POST "${BRIDGE_URL}/api/wi/dispatch/stream" \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:5175' \
  --max-time "$max_time" \
  -d "$body" 2>/dev/null || true)

if [ -z "$stream" ]; then
  printf 'error: empty SSE stream — bridge accepted connection but emitted nothing\n' >&2
  exit 3
fi

# ── relay non-result events to stderr ─────────────────────────────────────────
# Each SSE event is two lines: `event: NAME\ndata: JSON`. The Python helper
# below walks the stream, extracts (name, data) pairs, prints the non-noisy
# ones to stderr in a tidy form, then re-emits the *final* `result` and `done`
# events for the stdout-extraction step below.
printf "%s" "$stream" | STREAM="$stream" python3 -c '
import os, sys

stream = os.environ["STREAM"]
events = []
current_event = None
for raw in stream.splitlines():
    line = raw.rstrip("\r")
    if line.startswith("event: "):
        current_event = line[len("event: "):]
    elif line.startswith("data: "):
        events.append((current_event, line[len("data: "):]))
        current_event = None

# Stream the non-result events to stderr so the user can see the loop think.
for name, data in events:
    if name in ("result",):  # held back so stdout extraction can see it
        continue
    # Truncate long data blobs (text_delta accumulates) for stderr readability.
    truncated = data if len(data) <= 200 else data[:200] + "…"
    print(f"[event: {name}] {truncated}", file=sys.stderr)
' || true

# ── confirm_required short-circuit (exit 5) ───────────────────────────────────
if printf "%s" "$stream" | grep -q '^event: confirm_required'; then
  printf 'error: loop asked for interactive confirmation; this wrapper is single-shot.\n' >&2
  printf '  retry with --confirm-mode auto, or use /wi slash command for interactive confirm.\n' >&2
  exit 5
fi

# ── error event short-circuit (exit 1) ────────────────────────────────────────
if printf "%s" "$stream" | grep -q '^event: error'; then
  err_line=$(printf "%s" "$stream" | grep -m1 '^event: error' -A1 | tail -1 | sed 's/^data: //')
  printf 'error: loop emitted error event: %s\n' "$err_line" >&2
  exit 1
fi

# ── done-event required for stdout (exit 3 if missing) ────────────────────────
if ! printf "%s" "$stream" | grep -q '^event: done'; then
  printf 'error: timeout — no `event: done` within %ss\n' "$max_time" >&2
  printf '  (the bridge may be wedged or the loop ran longer than max-time)\n' >&2
  exit 3
fi

# ── extract LoopResult from the `result` event + emit env-var-shell stdout ────
# The `result` event's data is the full LoopResult JSON (see loop.ts:226-257).
# We pull session_id, verdict, surface (=final assistant text), iterations
# (=tool_calls.length), duration_ms; and grab engine from the `engine` event.
STREAM="$stream" python3 <<'PYEXTRACT'
import os, json, sys, shlex

stream = os.environ["STREAM"]

# Walk events; find the FIRST `engine` event's data and the LAST `result` event's data.
engine = ""
result_json = None
current_event = None
for raw in stream.splitlines():
    line = raw.rstrip("\r")
    if line.startswith("event: "):
        current_event = line[len("event: "):]
    elif line.startswith("data: "):
        data = line[len("data: "):]
        if current_event == "engine" and not engine:
            try:
                engine = json.loads(data).get("engine", "")
            except Exception:
                engine = ""
        elif current_event == "result":
            try:
                result_json = json.loads(data)
            except Exception:
                pass
        current_event = None

if result_json is None:
    print("error: no parseable `result` event in stream", file=sys.stderr)
    sys.exit(3)

session_id = result_json.get("session_id", "")
verdict = result_json.get("verdict", "")
surface = result_json.get("surface", "")
duration_ms = result_json.get("duration_ms", 0)
tool_calls = result_json.get("tool_calls", []) or []
iterations = len(tool_calls)

# Shell-quote everything so multi-line surface stays in one var when sourced.
# Using shlex.quote yields single-quoted strings safe for `eval $(this-script)`
# or `. <(this-script)`.
def q(value):
    return shlex.quote(str(value))

print(f"session_id={q(session_id)}")
print(f"verdict={q(verdict)}")
print(f"surface={q(surface)}")
print(f"iterations={q(iterations)}")
print(f"duration_ms={q(duration_ms)}")
print(f"engine={q(engine)}")
PYEXTRACT

exit 0
