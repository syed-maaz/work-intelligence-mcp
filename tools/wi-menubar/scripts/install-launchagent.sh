#!/usr/bin/env bash
#
# install-launchagent.sh — register WIMenuBar as a user LaunchAgent so launchd
# auto-restarts it after any exit (notably the macOS jetsam SIGKILL that the
# app's own signal handlers can't intercept).
#
# Idempotent: safe to run repeatedly. If a previous version is loaded, it's
# unloaded before the new plist is written.
#
# What it does, in order:
#   1. Resolve the absolute binary path inside WIMenuBar.app/Contents/MacOS/.
#   2. Verify the binary exists (build + bundle must have run first).
#   3. Render the plist template by substituting ${BINARY_PATH} + ${LOG_DIR}.
#   4. Unload any previously-installed copy (launchctl bootout).
#   5. Write the rendered plist to ~/Library/LaunchAgents/.
#   6. Load the new agent (launchctl bootstrap).
#   7. Tell the user what to do next.
#
# Why "bootstrap"/"bootout" instead of "load"/"unload": the load/unload verbs
# have been deprecated since macOS 10.10 and behave inconsistently on Sonoma+.
# The bootstrap/bootout verbs targeting `gui/<uid>` are the supported path for
# user LaunchAgents.
#
# Rollback: see uninstall-launchagent.sh.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$HERE")"
TEMPLATE="${HERE}/com.work-intelligence.menubar.plist.template"

LABEL="com.work-intelligence.menubar"
DEST_DIR="${HOME}/Library/LaunchAgents"
DEST_PLIST="${DEST_DIR}/${LABEL}.plist"

BINARY_PATH="${PROJECT_DIR}/WIMenuBar.app/Contents/MacOS/WIMenuBar"
LOG_DIR="${HOME}/Library/Logs/wi-menubar"

# 1+2: verify binary
if [[ ! -x "${BINARY_PATH}" ]]; then
  cat >&2 <<EOF
ERROR: WIMenuBar binary not found at:
  ${BINARY_PATH}

Build it first:
  npm run menubar:build

Then re-run this installer.
EOF
  exit 1
fi

# Make sure log dir exists — launchd refuses to create missing parent dirs
# for StandardOut/ErrorPath, so a missing dir would silently swallow any
# pre-WILog stderr output (the most diagnostic bytes we get).
mkdir -p "${LOG_DIR}"
mkdir -p "${DEST_DIR}"

# 3: render template
TMP_PLIST="$(mktemp)"
trap 'rm -f "${TMP_PLIST}"' EXIT
sed \
  -e "s|\${BINARY_PATH}|${BINARY_PATH}|g" \
  -e "s|\${LOG_DIR}|${LOG_DIR}|g" \
  "${TEMPLATE}" > "${TMP_PLIST}"

# 4: unload any previous copy. `bootout` exits non-zero if the label isn't
# loaded — that's fine, swallow it.
UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

# 5: install
cp "${TMP_PLIST}" "${DEST_PLIST}"
chmod 644 "${DEST_PLIST}"

# 6: load. Use bootstrap (replaces deprecated `load`).
launchctl bootstrap "gui/${UID_NUM}" "${DEST_PLIST}"

# Optional: kick it once immediately (RunAtLoad means launchd already did this,
# but a manual kickstart removes any doubt).
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true

# 7: report
cat <<EOF
[launchagent] installed → ${DEST_PLIST}
[launchagent] watching   → ${BINARY_PATH}
[launchagent] logs       → ${LOG_DIR}/menubar.log
[launchagent] pre-WILog  → ${LOG_DIR}/launchagent.{out,err}

WIMenuBar is now managed by launchd and will auto-restart after any exit
(including macOS jetsam SIGKILL, which the app cannot intercept).

To see status:
  launchctl print gui/${UID_NUM}/${LABEL} | head -40

To stop temporarily (until next login):
  launchctl bootout gui/${UID_NUM}/${LABEL}

To remove permanently:
  npm run menubar:autostart:off
EOF
