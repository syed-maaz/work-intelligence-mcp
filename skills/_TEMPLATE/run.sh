#!/usr/bin/env bash
# skills/_TEMPLATE/run.sh — reference no-op script.
# Copy this file into a new skill dir and replace the body.
# Contract: exit 0=success, 1=handled error, 2=fatal. stdout=JSON or markdown.
set -euo pipefail

echo '{"skill":"_TEMPLATE","status":"no-op","message":"replace this body"}'
exit 0
