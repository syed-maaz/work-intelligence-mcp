#!/usr/bin/env bash
# Launch the Work Intelligence MCP server over stdio.
# Referenced by ~/.hermes/config.yaml (mcp_servers.wi.command) and any other
# MCP host that speaks stdio. Loads .env and runs the built server so the host
# gets a clean stdio channel (no build noise on stdout).
set -euo pipefail

# Resolve the repo root from this script's location, independent of caller cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# The prebuilt native module (better-sqlite3) is compiled against Node 24's ABI
# (NODE_MODULE_VERSION 137 — the same runtime WIMenuBar.app bundles for the bridge).
# The PATH `node` an MCP host inherits may be a different install — e.g. Hermes ships
# its own Node 22 (ABI 127) at ~/.local/bin/node, which shadows nvm on PATH and crashes
# this server at import with a NODE_MODULE_VERSION mismatch. So we resolve a Node 24
# explicitly rather than trusting PATH. Precedence:
#   1) $WI_MCP_NODE if set (escape hatch for a future ABI bump)
#   2) newest v24.x under nvm
#   3) PATH node (last resort — may hit the ABI mismatch; we surface it loudly)
resolve_node() {
  if [[ -n "${WI_MCP_NODE:-}" && -x "${WI_MCP_NODE}" ]]; then
    printf '%s' "${WI_MCP_NODE}"; return
  fi
  local newest_v24
  newest_v24="$(ls -d "$HOME"/.nvm/versions/node/v24.* 2>/dev/null | sort -V | tail -1)/bin/node"
  if [[ -x "${newest_v24}" ]]; then
    printf '%s' "${newest_v24}"; return
  fi
  echo "[mcp-server.sh] no nvm Node 24.x found; falling back to PATH node ($(command -v node)) — may hit a NODE_MODULE_VERSION mismatch" >&2
  command -v node
}
NODE_BIN="$(resolve_node)"

# dist/server.js is the built stdio entry point (src/server.ts). Build it if missing.
if [[ ! -f dist/server.js ]]; then
  echo "[mcp-server.sh] dist/server.js missing — building…" >&2
  npm run build >&2
fi

# exec so signals from the MCP host propagate to the server process directly.
exec "${NODE_BIN}" --env-file=.env dist/server.js
