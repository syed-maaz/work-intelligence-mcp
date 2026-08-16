#!/usr/bin/env bash
# skills/wi-worktree-status/run.sh — git worktree list with ahead/behind + commit age.
set -uo pipefail

base="master"
git rev-parse "$base" &>/dev/null 2>&1 || base="main"

echo "worktree                                          branch                  ahead  behind  last_commit"
echo "------------------------------------------------  ----------------------  -----  ------  -----------"

git worktree list --porcelain | awk '
  /^worktree / { wt=$2 }
  /^branch /   { br=$2; sub("refs/heads/","",br) }
  /^HEAD /      { head=$2 }
  /^$/          { if (wt != "") print wt "|" br "|" head; wt=""; br="(detached)"; head="" }
  END           { if (wt != "") print wt "|" br "|" head }
' | while IFS='|' read -r wt br hd; do
  [ -z "$wt" ] && continue
  ahead=$(git -C "$wt" rev-list "$base".."$br" --count 2>/dev/null || echo "?")
  behind=$(git -C "$wt" rev-list "$br".."$base" --count 2>/dev/null || echo "?")
  age=$(git -C "$wt" log -1 --format="%cr" 2>/dev/null || echo "?")
  printf "%-50s  %-22s  %-5s  %-6s  %s\n" "$wt" "$br" "$ahead" "$behind" "$age"
done

exit 0
