---
title: wi-check-links
description: Validate [[wikilinks]] across the WI auto-memory and OpenClaw memory directories. Read-only.
---

# wi-check-links


Pattern stolen from the obsidian-claude-pkm and claudesidian projects, but scoped to the two directories WI/Atlas actually share, and stripped of any auto-fix behavior.

## When to use

- Before publishing a new memory entry — confirm your `[[…]]` refs land somewhere
- During a memory cleanup pass — surface dangling refs after a rename
- As a regression detector after running `wi-frontmatter` (which can suggest slug changes)

## Usage

```bash
node ~/.claude/skills/work-intelligence/wi-check-links/check-links.mjs
node ~/.claude/skills/work-intelligence/wi-check-links/check-links.mjs --fix-suggest
```

The skill auto-loads when you say things like:

- "check the wikilinks in memory"
- "are any [[refs]] broken?"
- "validate cross-references in my notes"

## How resolution works

| Reference form | Resolves against |
|---|---|
| `[[some-slug]]` | `name:` frontmatter in any auto-memory file, OR filename stem in OpenClaw |
| `[[some-slug\|alias]]` | Same; alias is ignored for resolution |
| `[[some-slug#header]]` | Same; header is not validated |
| `[[../path/to/file]]` | Resolved against the source file's directory (relative path) |
| `[[#some-header]]` | Skipped (intra-doc anchor) |

Daily-note style names (`YYYY-MM-DD-…`) that don't match anything are reported as INFO, not WARN — forward references to future daily notes are common.

## Output

Markdown report grouped by source file:

```
## ~/.claude/projects/.../memory/some-file.md
- WARN L42: `[[stale-slug]]`
  - did you mean: `live-slug` (d=2), `live-slot` (d=3)
- INFO L73: `[[2026-12-25-future-note]]`
```

## Exit codes

- `0` — every ref resolved (info-only entries are still 0)
- `1` — at least one unresolved ref
- `2` — script error

## What this skill does NOT do

- It does not auto-rewrite or fix any links
- It does not validate plain markdown links or URLs — only `[[wikilinks]]`
- It does not validate header anchors after `#`
