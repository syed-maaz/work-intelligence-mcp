#!/usr/bin/env bash
# Exit 0 only for a completed clean scan, 1 for leaks, 2 for scanner errors.
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/leak-scan.mjs" "$@"
