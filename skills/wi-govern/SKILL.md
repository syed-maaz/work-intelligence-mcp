---
name: wi-govern
description: "Governance: links, frontmatter, memory, recall. Subcommand-dispatch."
trigger_phrases:
  - "check wiki links"
  - "frontmatter audit"
  - "memory governance"
  - "recall audit"
  - "governance sweep"
argument-hint: "<subcommand> [args]"
allowed-tools: [Bash]
metadata:
  bucket: E-thick
  run_script: run.sh
  invocation: "bash skills/wi-govern/run.sh <subcommand>"
  subcommands:
    - name: links
      description: "Validate [[wikilinks]] across WI auto-memory dir."
      invocation: "bash skills/wi-govern/run.sh links"
    - name: frontmatter
      description: "Audit frontmatter across WI auto-memory dir."
      invocation: "bash skills/wi-govern/run.sh frontmatter"
    - name: memory
      description: "Audit WI auto-memory index (MEMORY.md) for size and over-long index lines."
      invocation: "bash skills/wi-govern/run.sh memory"
    - name: recall
      description: "Sweep recognition sim-gate and report recall."
      invocation: "bash skills/wi-govern/run.sh recall"
  endpoints: []
  reads_tables: []
  writes_tables: []
  writes_mutating: false
  related_skills: []
  triggers: []
  born: 2026-07-24
  last_verified: 2026-07-24
  model:
    provider: anthropic
    tier: haiku
    override: null
    rationale: "Dispatches to scripts; LLM only renders output."
---

# wi-govern

## Purpose

Governance and maintenance for Work Intelligence — validate wikilinks, audit frontmatter, check memory index size, and sweep recognition recall gates.

## When to use

- `wi-govern links` when wiki references may be broken
- `wi-govern frontmatter` when checking frontmatter integrity
- `wi-govern memory` when MEMORY.md is approaching size limits
- `wi-govern recall` when tuning recognition sim-gate performance

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `links` | — | Validate [[wikilinks]] across the WI auto-memory dir. |
| `frontmatter` | — | Audit frontmatter for presence, required fields, and version drift. |
| `memory` | — | Audit MEMORY.md for size and over-long index lines. |
| `recall` | — | Sweep sim-gate thresholds and report top-1/top-5 recall. |

## Endpoints touched

None.

## Failure modes

- Script-specific failures documented in each `subs/<name>.mjs` header.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — merged from wi-check-links, wi-frontmatter, wi-memory-compact, wi-recall-tune (see PLAN.md § 4).
