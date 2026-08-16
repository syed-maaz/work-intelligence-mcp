---
name: wi-skill-install
description: |
  Install or re-verify the WI skill catalog from this repo into the user's
  Claude Code skill directory. Wires repo→subtree SKILL.md symlinks AND
  top-level slash-command symlinks. Detects three drift dimensions:
  (1) subtree dirs missing top-level symlinks, (2) subtree skills not in
  repo, (3) broken symlinks pointing to non-existent repo paths. Idempotent.
trigger_phrases:
  - "reinstall skill symlinks"
  - "fix skill layout"
  - "install wi skills"
  - "re-verify skill catalog"
metadata:
  type: project
  triggers:
    - install wi skills
    - register wi skills
    - fix wi skill symlinks
    - after adding a new wi-* skill
  evidence_url: feedback_skill_top_level_symlinks.md, feedback_skill_registration.md
  born: 2026-06-11
  cypher_proof_point: 01
allowed-tools: Bash
---

# wi-skill-install

Run `bash scripts/install-skills.sh` from the WI repo root.

## When to use

- After adding any new `wi-*` skill under `skills/<name>/SKILL.md` in the repo.
- After renaming or removing a skill in the repo.
- After a fresh repo clone or after `~/.claude/` is wiped.
- When `/wi-*` slash commands silently 404 ("Unknown command") — top-level symlink probably missing.
- Before committing skill changes — the script's exit code is the smoke gate.

## Inputs

- The repo's `skills/` directory (source of truth for SKILL.md content).
- `~/.claude/skills/work-intelligence/` (consumer subtree — the dirs Claude Code reads).
- `~/.claude/skills/wi-*` (top-level symlinks — what registers the slash commands).

## Outputs

- All `wi-*` skills wired correctly across all three layers.
- Drift report on stderr if anything was off.
- Exit 0 on clean state; exit 2 on unresolvable real-file collision.

## Side effects

- Creates `~/.claude/skills/work-intelligence/<name>/` real directories as needed.
- Creates SKILL.md symlinks pointing at `<repo>/skills/<name>/SKILL.md`.
- Creates `~/.claude/skills/<name>` top-level symlinks pointing at consumer dirs.
- Detects and reports broken symlinks (subtree SKILL.md whose repo target is missing) — does NOT auto-delete; user must dispose explicitly.

## How it works

```bash
# Run from repo root:
bash scripts/install-skills.sh
```

Three-pass:

1. **Subtree wiring** — for each `repo/skills/<name>/SKILL.md`, ensure `~/.claude/skills/work-intelligence/<name>/SKILL.md` is a symlink pointing at it.
2. **Top-level registration** — for each consumer subtree dir, ensure `~/.claude/skills/<name>` is a symlink pointing at it.
3. **Drift detection** — surface broken symlinks (target missing) and orphan subtree dirs (in subtree but not in repo).

## Anti-patterns

- Never silently overwrite a real-file SKILL.md in the consumer subtree — it may hold unmerged edits. Surface and abort.
- Never delete subtree dirs with valid symlinks just because they're not in repo — that's a separate retirement decision (and a CAP-14 audit concern).
- Never run from a directory other than the repo root — path resolution depends on `$REPO_ROOT/scripts`.

## Restart Claude Code after install

The slash-command registry loads at session start. New top-level symlinks created mid-session do **not** retroactively register — restart Claude Code to pick them up.

## Related

- `feedback_skill_top_level_symlinks` — original pain capture.
- `feedback_skill_registration` — diagnostic recipe (`claude -p --debug-file`).
- CAP-13 (Cypher's self-extension capability) — this skill is its first dogfood (proof point 01).
- `scripts/install-skills.sh` — the implementation this skill wraps.
