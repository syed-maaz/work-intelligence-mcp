#!/usr/bin/env bash
# skills/wi-symlink-check/run.sh — find broken symlinks under ~/Documents and ~/Desktop.
set -uo pipefail

broken=()
while IFS= read -r link; do
  broken+=("$link")
done < <(find ~/Documents ~/Desktop -maxdepth 3 -type l -exec test ! -e {} \; -print 2>/dev/null)

if [ "${#broken[@]}" -eq 0 ]; then
  echo '{"broken_symlinks":[],"count":0}'
else
  echo '{"broken_symlinks":['
  first=1
  for l in "${broken[@]}"; do
    [ "$first" -eq 0 ] && echo ','
    printf '"%s"' "$l"
    first=0
  done
  printf '],"count":%d}\n' "${#broken[@]}"
fi
exit 0
