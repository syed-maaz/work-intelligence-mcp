#!/usr/bin/env bash
#
# uninstall-launchagent.sh — reverse install-launchagent.sh. Unloads the
# agent from launchd and deletes the plist. Leaves the binary, the app
# bundle, and the log directory in place.
#
# Idempotent: safe even if the agent was never installed.

set -euo pipefail

LABEL="com.work-intelligence.menubar"
DEST_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

# Unload first — bootout fails silently if not loaded, which is fine.
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

if [[ -f "${DEST_PLIST}" ]]; then
  rm -f "${DEST_PLIST}"
  echo "[launchagent] removed → ${DEST_PLIST}"
else
  echo "[launchagent] no plist at ${DEST_PLIST}; nothing to remove"
fi

cat <<EOF
WIMenuBar is no longer managed by launchd. It will not auto-restart after
exit. To run it manually:
  npm run menubar:run
EOF
