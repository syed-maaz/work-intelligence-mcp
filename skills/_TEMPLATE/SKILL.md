---
name: wi-EXAMPLE
description: "One sentence describing what this skill does. Max 160 chars."
argument-hint: "[args here or leave empty]"
allowed-tools:
  - Bash
metadata:
  bucket: A
  run_script: run.sh
  invocation: "bash skills/wi-EXAMPLE/run.sh"
  endpoints: []
  reads_tables: []
  writes_tables: []
  writes_mutating: false
  related_skills: []
  triggers: []  # ADD before committing — empty triggers = skill never fires (see GAP-003)
  born: 2026-07-23
  last_verified: 2026-07-23
  model:
    provider: anthropic
    tier: haiku
    override: null
    rationale: "Bucket A default: LLM only renders script output."
---

# wi-EXAMPLE

## Purpose
PLACEHOLDER — what problem does this skill solve, for whom, at what moment?

## When to use
PLACEHOLDER — bullet list of concrete triggers.

## When NOT to use
PLACEHOLDER — near-neighbours the user might confuse this with.

## Script contract
```
Invocation:   bash skills/wi-EXAMPLE/run.sh [args]
Exit codes:   0=success, 1=handled error, 2=fatal
Output:       JSON on stdout
Side effects: none
```

## Endpoints touched
PLACEHOLDER — list of endpoints from frontmatter, restated in prose.

## Failure modes with real evidence
PLACEHOLDER — each failure mode links to an ADR / bug / session id.

## Related work
PLACEHOLDER — ADR-NNN, .planning/*/NN-*.md, memory anchors.

## Changelog
- 2026-07-23 — created from skills/_TEMPLATE/.
