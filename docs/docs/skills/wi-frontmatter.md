---
title: wi-frontmatter
description: Audit frontmatter in WI auto-memory files — checks presence, required fields, name-slug version drift, and metadata.type enum sanity. Read-only.
---

# wi-frontmatter


Pattern stolen from the obsidian-claude-pkm and claudesidian projects (frontmatter discipline), tightened to skip our index file and any future daily-note pattern.

## Checks

| # | Check | Severity |
|---|---|---|
| 1 | Frontmatter present and terminated (`---` block at top) | ERROR if missing |
| 2 | Required fields: `name`, `description` | ERROR if missing |
| 3 | `metadata.type` block present | WARN if missing |
| 4 | `metadata.type` is one of `{user, feedback, project, reference, fact, bug, decision, jira}` | WARN on novel value |
| 5 | If `name:` contains `vNN`, body references no higher `vMM` | WARN if drift detected |

## When to use

- After landing a memory edit — confirm metadata is still well-formed
- During cleanup — surface slug/body drift like `name: fact-schema-v45` whose body says v48
- Before renaming an entry — see what's load-bearing before you touch it

## Usage

```bash
node ~/.claude/skills/work-intelligence/wi-frontmatter/audit.mjs
node ~/.claude/skills/work-intelligence/wi-frontmatter/audit.mjs report   # alias
```

The skill auto-loads when you say things like:

- "audit memory frontmatter"
- "are any memory files missing fields?"
- "is `fact_schema_vNN` out of date?"

## Excluded

- `MEMORY.md` — the index, intentionally has no frontmatter
- `YYYY-MM-DD-*.md` — daily-note pattern; no frontmatter expected (guard for future drift)

## Exit codes

- `0` — all OK
- `1` — at least one WARN or ERROR
- `2` — script error (missing dir, etc.)

## What this skill does NOT do

- It does not edit any memory file
- It does not validate `description` content (only presence)
- It does not check `[[wikilinks]]` — that's [`wi-check-links`](wi-check-links)
- It does not touch the OpenClaw memory dir
