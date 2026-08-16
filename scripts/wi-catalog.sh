#!/usr/bin/env bash
# scripts/wi-catalog.sh — view skills/_catalog.json.
# Usage: wi-catalog.sh --format=full | --format=json
set -euo pipefail

FMT="full"
for arg in "$@"; do
  case "$arg" in
    --format=json) FMT="json" ;;
    --format=full) FMT="full" ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

CAT="$(git rev-parse --show-toplevel)/skills/_catalog.json"
[ -f "$CAT" ] || { echo "no _catalog.json at $CAT — run: node scripts/build-skill-catalog.mjs" >&2; exit 1; }

if [ "$FMT" = "json" ]; then
  cat "$CAT"
else
  jq -r '
    "# WI Skill Catalog (\(.count) skills, generated \(.generated_at))\n",
    (.skills[] |
      "## \(.name)  [bucket=\(.bucket // "?"), tier=\(.model.tier // "?")]",
      "\(.description)",
      "  invocation:  \(.invocation // "n/a")",
      "  endpoints:   \((.endpoints // []) | join(", "))",
      "  triggers:    \((.triggers // []) | join(", "))",
      "  subcommands: \((.subcommands // []) | map(.name) | join(", "))",
      "  related:     \((.related_skills // []) | join(", "))",
      ""
    )
  ' "$CAT"
fi
