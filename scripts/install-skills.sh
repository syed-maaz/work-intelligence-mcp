#!/usr/bin/env bash
# Install (or re-verify) WI skill layout from this repo into ~/.claude/skills/work-intelligence/.
#
# Layout per skill:
#   ~/.claude/skills/work-intelligence/<name>/        ← real directory (required: lstat.isDirectory)
#   ~/.claude/skills/work-intelligence/<name>/SKILL.md ← symlink → <repo>/skills/<name>/SKILL.md
#
# Source of truth: <repo>/skills/<name>/SKILL.md
#
# Idempotent: re-running on a healthy tree is a no-op and exits 0.
# If the consumer SKILL.md path exists as a real file (drift), we abort with a
# clear message — we do NOT silently overwrite, since it may hold unmerged edits.

set -euo pipefail

# ─── Flag parsing (added 2026-07-25 — ghost-catalog cleanup) ────────────────
# --prune : delete orphan subtree dirs (in consumer but not in repo) AND
#           orphan top-level symlinks. Default OFF for safety — opt-in via flag
#           or INSTALL_SKILLS_PRUNE=1 env var.
# --dry-run : print what --prune would do, delete nothing.
PRUNE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --prune)   PRUNE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      echo "Usage: $0 [--prune] [--dry-run]"
      echo "  --prune    delete orphan subtree dirs + top-level symlinks not in repo"
      echo "  --dry-run  with --prune: print what would be deleted, delete nothing"
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done
if [ "${INSTALL_SKILLS_PRUNE:-0}" = "1" ]; then PRUNE=1; fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
SKILLS_DST="$HOME/.claude/skills/work-intelligence"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "error: $SKILLS_SRC does not exist" >&2
  exit 1
fi

mkdir -p "$SKILLS_DST"

linked=0
already=0
drifted=()

for src_dir in "$SKILLS_SRC"/*/; do
  name="$(basename "$src_dir")"
  src_skill="${src_dir%/}/SKILL.md"
  dst_dir="$SKILLS_DST/$name"
  dst_skill="$dst_dir/SKILL.md"

  # Ensure the consumer dir is a real directory (not a symlink — lstat must see isDirectory)
  if [ -L "$dst_dir" ]; then
    echo "fix: replacing dir-symlink with real dir for $name"
    rm "$dst_dir"
    mkdir -p "$dst_dir"
  else
    mkdir -p "$dst_dir"
  fi

  # Wire SKILL.md symlink
  if [ -L "$dst_skill" ]; then
    current="$(readlink "$dst_skill")"
    if [ "$current" = "$src_skill" ]; then
      already=$((already + 1))
      continue
    fi
    echo "fix: $dst_skill -> $current  =>  $src_skill"
    rm "$dst_skill"
    ln -s "$src_skill" "$dst_skill"
    linked=$((linked + 1))
    continue
  fi

  if [ -e "$dst_skill" ]; then
    drifted+=("$dst_skill")
    continue
  fi

  ln -s "$src_skill" "$dst_skill"
  linked=$((linked + 1))
done

if [ "${#drifted[@]}" -gt 0 ]; then
  echo "" >&2
  echo "error: the following paths exist as real files and would be clobbered:" >&2
  for p in "${drifted[@]}"; do echo "  - $p" >&2; done
  echo "" >&2
  echo "resolve manually (diff against repo, then rm or merge), then re-run." >&2
  exit 2
fi

# Pass 2 — top-level symlinks for slash-command registration.
# Claude Code's skill loader scans ~/.claude/skills/* TOP-LEVEL only;
# subtree dirs are not picked up unless a top-level symlink exists.
SKILLS_TOP="$HOME/.claude/skills"
top_linked=0
top_already=0
for src_dir in "$SKILLS_SRC"/*/; do
  name="$(basename "$src_dir")"
  consumer_dir="$SKILLS_DST/$name"
  top_link="$SKILLS_TOP/$name"

  if [ -L "$top_link" ]; then
    current_top="$(readlink "$top_link")"
    if [ "$current_top" = "$consumer_dir" ]; then
      top_already=$((top_already + 1))
      continue
    fi
    echo "fix top-level: $top_link -> $current_top  =>  $consumer_dir"
    rm "$top_link"
    ln -s "$consumer_dir" "$top_link"
    top_linked=$((top_linked + 1))
    continue
  fi

  if [ -e "$top_link" ]; then
    echo "warn: $top_link exists as non-symlink; skipping (resolve manually)" >&2
    continue
  fi

  ln -s "$consumer_dir" "$top_link"
  top_linked=$((top_linked + 1))
done

# Pass 2b (added 2026-07-25) — router alias.
# `~/.claude/skills/wi` is the /wi slash-command entry point. It's a top-level
# symlink to the wi-router skill's consumer dir. Historically this was a
# one-time manual setup; if the target ever moved or the symlink got clobbered,
# `/wi` silently stopped working. Bake it in here so install-skills.sh is
# self-healing.
ROUTER_TARGET="$SKILLS_DST/wi-router"
ROUTER_LINK="$SKILLS_TOP/wi"
if [ -d "$ROUTER_TARGET" ]; then
  if [ -L "$ROUTER_LINK" ]; then
    current_router="$(readlink "$ROUTER_LINK")"
    if [ "$current_router" != "$ROUTER_TARGET" ]; then
      echo "fix router alias: $ROUTER_LINK -> $current_router  =>  $ROUTER_TARGET"
      rm "$ROUTER_LINK"
      ln -s "$ROUTER_TARGET" "$ROUTER_LINK"
    fi
  elif [ -e "$ROUTER_LINK" ]; then
    echo "warn: $ROUTER_LINK exists as non-symlink; /wi may not work — resolve manually" >&2
  else
    echo "linking router alias: $ROUTER_LINK -> $ROUTER_TARGET"
    ln -s "$ROUTER_TARGET" "$ROUTER_LINK"
  fi
else
  echo "warn: router target missing ($ROUTER_TARGET) — /wi will not work until wi-router is installed" >&2
fi

# Pass 3 — drift detection. Surface broken symlinks + orphan subtree dirs.
broken_symlinks=()
orphan_subtree=()
for d in "$SKILLS_DST"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  s="$d/SKILL.md"
  # Broken symlink: SKILL.md is a symlink but target doesn't exist
  if [ -L "$s" ] && [ ! -e "$s" ]; then
    broken_symlinks+=("$d")
    continue
  fi
  # Orphan subtree: dir exists in consumer but not in repo
  if [ ! -d "$SKILLS_SRC/$name" ]; then
    orphan_subtree+=("$d")
  fi
done

echo "skills: $linked linked, $already already correct"
echo "top-level: $top_linked linked, $top_already already correct"

if [ "${#broken_symlinks[@]}" -gt 0 ]; then
  echo "" >&2
  if [ "$PRUNE" = "1" ]; then
    action_prefix=$([ "$DRY_RUN" = "1" ] && echo "DRY-RUN would rm" || echo "PRUNE rm")
    echo "$action_prefix: ${#broken_symlinks[@]} broken-symlink subtree dirs (SKILL.md target missing in repo):" >&2
    pruned=0
    for p in "${broken_symlinks[@]}"; do
      name="$(basename "$p")"
      echo "  - $p" >&2
      if [ "$DRY_RUN" != "1" ]; then
        rm -rf "$p"
        top_link="$SKILLS_TOP/$name"
        if [ -L "$top_link" ]; then
          rm "$top_link"
          echo "    + removed top-level symlink $top_link" >&2
        fi
        pruned=$((pruned + 1))
      fi
    done
    [ "$DRY_RUN" != "1" ] && echo "  pruned $pruned broken-symlink dirs" >&2
  else
    echo "warn: ${#broken_symlinks[@]} broken-symlink subtree dirs (target missing in repo):" >&2
    for p in "${broken_symlinks[@]}"; do echo "  - $p" >&2; done
    echo "  resolution: rm these dirs, OR re-create the missing repo skill, OR rerun with --prune." >&2
  fi
fi

if [ "${#orphan_subtree[@]}" -gt 0 ]; then
  echo "" >&2
  if [ "$PRUNE" = "1" ]; then
    action_prefix=$([ "$DRY_RUN" = "1" ] && echo "DRY-RUN would rm" || echo "PRUNE rm")
    echo "$action_prefix: ${#orphan_subtree[@]} orphan subtree dirs (in consumer but not in repo):" >&2
    pruned=0
    for p in "${orphan_subtree[@]}"; do
      name="$(basename "$p")"
      echo "  - $p" >&2
      if [ "$DRY_RUN" != "1" ]; then
        rm -rf "$p"
        # Also drop the matching top-level symlink if it points at this consumer dir
        top_link="$SKILLS_TOP/$name"
        if [ -L "$top_link" ]; then
          rm "$top_link"
          echo "    + removed top-level symlink $top_link" >&2
        fi
        pruned=$((pruned + 1))
      fi
    done
    [ "$DRY_RUN" != "1" ] && echo "  pruned $pruned orphan subtree dirs" >&2
  else
    echo "warn: ${#orphan_subtree[@]} orphan subtree dirs (in consumer but not in repo):" >&2
    for p in "${orphan_subtree[@]}"; do echo "  - $p" >&2; done
    echo "  resolution: commit the skill to repo, OR rm the consumer dir, OR rerun with --prune." >&2
  fi
fi

# Pass 4 (added 2026-07-25) — orphan top-level SYMLINKS.
# Pass 3 catches dirs; Pass 4 catches top-level symlinks whose consumer dir was
# already removed. A symlink is orphan iff its target no longer exists.
# NOTE: same-name-in-repo is NOT required — the router (~/.claude/skills/wi)
# legitimately points at .../work-intelligence/wi-router with no matching
# skills/wi/ directory. Only broken targets get pruned.
orphan_top_links=()
for link in "$SKILLS_TOP"/*; do
  [ -L "$link" ] || continue
  # Only consider links whose target sits in our consumer dir (safe scope).
  target="$(readlink "$link")"
  case "$target" in
    "$SKILLS_DST"/*)
      # Orphan iff the target directory no longer exists (broken symlink).
      if [ ! -e "$target" ]; then
        orphan_top_links+=("$link")
      fi
      ;;
  esac
done

if [ "${#orphan_top_links[@]}" -gt 0 ]; then
  echo "" >&2
  if [ "$PRUNE" = "1" ]; then
    action_prefix=$([ "$DRY_RUN" = "1" ] && echo "DRY-RUN would rm" || echo "PRUNE rm")
    echo "$action_prefix: ${#orphan_top_links[@]} orphan top-level symlinks (target not in repo):" >&2
    for l in "${orphan_top_links[@]}"; do
      echo "  - $l" >&2
      [ "$DRY_RUN" != "1" ] && rm "$l"
    done
  else
    echo "warn: ${#orphan_top_links[@]} orphan top-level symlinks:" >&2
    for l in "${orphan_top_links[@]}"; do echo "  - $l" >&2; done
    echo "  resolution: rerun with --prune to remove." >&2
  fi
fi

# Symlink run.sh / helper scripts (added 2026-07-23)
for skill_dir in "$REPO_ROOT"/skills/*/; do
  skill_name=$(basename "$skill_dir")
  [ "$skill_name" = "_TEMPLATE" ] && continue
  shopt -s nullglob
  for script in "$skill_dir"run.sh "$skill_dir"*.mjs; do
    [ -f "$script" ] || continue
    script_name=$(basename "$script")
    target="$HOME/.claude/skills/work-intelligence/$skill_name/$script_name"
    mkdir -p "$(dirname "$target")"
    ln -sf "$script" "$target"
    chmod +x "$script"
    echo "  symlinked $skill_name/$script_name"
  done
  shopt -u nullglob
done

# =========================================================================
# HERMES INSTALL (added 2026-07-23 — model-neutral skill parity)
# =========================================================================
# Hermes uses a flat layout: ~/.hermes/skills/wi/<skill-name>/ symlinked
# directly to <repo>/skills/<skill-name>/ (the whole dir, not just SKILL.md).
# Zero-config for Hermes: it picks up every wi-* skill automatically.
HERMES_DST="$HOME/.hermes/skills/wi"
if [ -d "$HOME/.hermes" ] || [ -n "${HERMES_INSTALL:-}" ]; then
  mkdir -p "$HERMES_DST"
  hermes_linked=0
  hermes_already=0
  for src_dir in "$SKILLS_SRC"/*/; do
    name="$(basename "$src_dir")"
    [ "$name" = "_TEMPLATE" ] && continue
    dst="$HERMES_DST/$name"
    src_abs="${src_dir%/}"
    if [ -L "$dst" ]; then
      current="$(readlink "$dst")"
      if [ "$current" = "$src_abs" ]; then
        hermes_already=$((hermes_already + 1))
        continue
      fi
      rm "$dst"
    elif [ -e "$dst" ]; then
      echo "warn: $dst exists as non-symlink; skipping" >&2
      continue
    fi
    ln -s "$src_abs" "$dst"
    hermes_linked=$((hermes_linked + 1))
  done
  echo "hermes: $hermes_linked linked, $hermes_already already correct"

  # Prune orphan Hermes symlinks (added 2026-07-25)
  hermes_orphans=()
  for link in "$HERMES_DST"/*; do
    [ -L "$link" ] || continue
    hname="$(basename "$link")"
    if [ ! -d "$SKILLS_SRC/$hname" ]; then
      hermes_orphans+=("$link")
    fi
  done
  if [ "${#hermes_orphans[@]}" -gt 0 ]; then
    if [ "$PRUNE" = "1" ]; then
      action_prefix=$([ "$DRY_RUN" = "1" ] && echo "DRY-RUN would rm" || echo "PRUNE rm")
      echo "$action_prefix: ${#hermes_orphans[@]} orphan Hermes symlinks (target not in repo):" >&2
      for l in "${hermes_orphans[@]}"; do
        echo "  - $l" >&2
        [ "$DRY_RUN" != "1" ] && rm "$l"
      done
    else
      echo "warn: ${#hermes_orphans[@]} orphan Hermes symlinks:" >&2
      for l in "${hermes_orphans[@]}"; do echo "  - $l" >&2; done
      echo "  resolution: rerun with --prune to remove." >&2
    fi
  fi
fi

# ─── Final drift summary (added 2026-07-25) ─────────────────────────────────
# One assertive line if there's ANY drift and --prune wasn't passed. Without
# this, drift warnings scroll past in a long output and someone re-running the
# install thinks everything's fine. With --prune the fix already happened.
if [ "$PRUNE" != "1" ]; then
  total_drift=$(( ${#broken_symlinks[@]:-0} + ${#orphan_subtree[@]:-0} + ${#orphan_top_links[@]:-0} + ${#hermes_orphans[@]:-0} ))
  if [ "$total_drift" -gt 0 ]; then
    echo "" >&2
    echo "═══════════════════════════════════════════════════════════════════" >&2
    echo "DRIFT DETECTED — $total_drift stale item(s) not in repo skills/." >&2
    echo "  This is how the ghost-catalog bug happens: the model still sees" >&2
    echo "  these names and can misroute /wi dispatches to plugin fallbacks." >&2
    echo "  Rerun with:  $0 --prune" >&2
    echo "  Or preview:  $0 --prune --dry-run" >&2
    echo "═══════════════════════════════════════════════════════════════════" >&2
  fi
fi
