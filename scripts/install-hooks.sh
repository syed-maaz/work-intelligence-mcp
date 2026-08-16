#!/usr/bin/env bash
# scripts/install-hooks.sh
# One-time setup: activate this repo's committed .githooks/ directory.
# Idempotent — safe to re-run.
#
# git config core.hooksPath is per-clone, not tracked in the repo,
# so every fresh clone / worktree needs this run once.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Install .githooks for $(basename "$REPO_ROOT") ==="

# 1. Ensure hooks are executable
chmod +x .githooks/pre-commit .githooks/pre-push
echo "✓ hooks marked executable"

# 2. Point git at the committed hooks dir
current="$(git config core.hooksPath 2>/dev/null || echo '')"
if [[ "$current" == ".githooks" ]]; then
  echo "✓ core.hooksPath already set to .githooks"
else
  git config core.hooksPath .githooks
  echo "✓ core.hooksPath set to .githooks (was: '${current:-default}')"
fi

# 3. Verify hooks fire
echo ""
echo "=== Hooks installed ==="
ls -la .githooks/pre-* | awk '{print "  " $NF, "(" $1 ")"}'
echo ""
echo "Test hook by attempting a protected commit:"
echo "  cd ~/.slots/wi/slot-X/  # (if a slot exists)"
echo "  echo test > /tmp/t; git add /tmp/t"
echo "  git commit --allow-empty -m 'test'"
echo "  # (should refuse if on master from a slot)"
echo ""
echo "Emergency bypass: --no-verify"
