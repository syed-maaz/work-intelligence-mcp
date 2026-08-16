---
title: Skill management
description: How WI agent skills are version-controlled in this repo and made visible to Claude Code via symlinks.
---

# Skill management

WI agent skills (the `wi-*` ones — `wi-investigate`, `wi-morning-brief`, `wi-pr-review`, etc.) are version-controlled in this repo under [`skills/`](https://github.com/) and surfaced to Claude Code via symlinks under `~/.claude/skills/work-intelligence/`.

This page documents the layout, the install script, and how to roll back if something breaks.

## Layout

```
<repo>/
  skills/
    wi-investigate/
      SKILL.md
    wi-morning-brief/
      SKILL.md
    …

~/.claude/skills/work-intelligence/
    wi-investigate     -> <repo>/skills/wi-investigate
    wi-morning-brief   -> <repo>/skills/wi-morning-brief
    …
```

Claude Code reads from the `~/.claude/...` paths but they are symlinks — editing `<repo>/skills/<name>/SKILL.md` and committing is the entire publish step. There is no separate copy step, no build, no registry.

## Why symlinks instead of copies

- **One source of truth.** A skill diff lives next to the code it touches.
- **No drift.** Edits to the live skill *are* edits to the repo file.
- **PR-reviewable.** Skill changes go through the same review as any other code.
- **Cheap rollback.** `git checkout -- skills/<name>/SKILL.md` restores it instantly; the symlink doesn't need to move.

## Installing or repairing the symlinks

After a fresh clone, after `~/.claude/` is wiped, or if a skill directory drifted into a real folder somehow:

```bash
bash scripts/install-skills.sh
```

The script is idempotent. On a healthy tree it prints `skills: 0 linked, 24 already correct` and exits 0. On first run after a clone it prints `skills: 24 linked, 0 already correct`.

If the consumer path (`~/.claude/skills/work-intelligence/<name>`) exists as a **real directory** rather than a symlink, the script aborts with exit 2 and lists the offending paths. It does not silently overwrite — that path could hold unmerged user edits. You either `diff` against the repo and merge, or `rm -rf` the consumer dir if you've confirmed it's a stale copy, then re-run.

## Adding a new skill

```bash
mkdir -p skills/wi-newskill
$EDITOR skills/wi-newskill/SKILL.md
bash scripts/install-skills.sh        # creates the symlink
git add skills/wi-newskill && git commit -m "feat(skills): add wi-newskill"
```

That's the whole workflow.

## Rollback

A backup tarball of the pre-relocation state is at `/tmp/wi-skills-backup/skills-pre-relocate-20260524-144319.tgz`. To restore the original `~/.claude/`-only layout:

```bash
rm -rf ~/.claude/skills/work-intelligence
tar -xzf /tmp/wi-skills-backup/skills-pre-relocate-20260524-144319.tgz \
  -C ~/.claude/skills/
rm -rf <repo>/skills
git checkout master -- .
```

The tarball is not committed to the repo — it's a one-shot rollback artifact for the migration day. After the migration is bedded in, the artifact can be deleted; further rollbacks just use `git`.

## What this does not do

- It does not symlink into other agent harnesses (Cursor, OpenClaw, `.pi/`). Single consumer for now.
- It does not register skills with the MCP `wi_*` manifest in `src/tools/manifest.ts` — skills and MCP tools are separate surfaces. Skills are interactive prompts loaded by Claude Code; the manifest is the JSON-RPC tool list served over stdio/HTTP.
- It does not touch `~/.claude/skills/engineering-skills/` — that is a different namespace, owned by a different repo.
