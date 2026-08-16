---
name: wi-audit
description: "System audits: storage, dead-writes, kg-freshness, analyze. Subcommand-dispatch."
trigger_phrases:
  - "audit the system"
  - "system health check"
  - "storage audit"
  - "dead writes"
  - "kg freshness"
  - "audit analyze"
argument-hint: "<subcommand> [args]"
allowed-tools: [Bash]
metadata:
  bucket: E-thick
  run_script: run.sh
  invocation: "bash skills/wi-audit/run.sh <subcommand>"
  subcommands:
    - name: storage
      description: "Per-table storage audit via sqlite3 dbstat."
      invocation: "bash skills/wi-audit/run.sh storage"
    - name: dead-writes
      description: "Detect stale write paths (code writing to tables no reader uses)."
      invocation: "bash skills/wi-audit/run.sh dead-writes"
    - name: kg-freshness
      description: "Check knowledge graph table freshness."
      invocation: "bash skills/wi-audit/run.sh kg-freshness"
    - name: analyze
      description: "Composed audit — runs storage, dead-writes, kg-freshness and aggregates."
      invocation: "bash skills/wi-audit/run.sh analyze"
  endpoints: []
  reads_tables: []
  writes_tables: []
  writes_mutating: false
  related_skills: [wi-health]
  triggers: []
  born: 2026-07-24
  last_verified: 2026-07-24
  model:
    provider: anthropic
    tier: haiku
    override: null
    rationale: "Dispatches to scripts; LLM only renders output."
---

# wi-audit

## Purpose

System-level audits for Work Intelligence — storage usage, stale write detection, knowledge graph freshness, and composed analysis across all three.

## When to use

- `wi-audit storage` when checking database table sizes and usage
- `wi-audit dead-writes` when looking for unused write paths
- `wi-audit kg-freshness` when verifying knowledge graph is up-to-date
- `wi-audit analyze` when you want a comprehensive audit combining all three

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `storage` | — | Per-table storage audit: rows, bytes, readers, writers, liveness. |
| `dead-writes` | — | Detect code writing to tables that no code reads. |
| `kg-freshness` | — | Check knowledge graph table last-update times. |
| `analyze` | — | Runs storage + dead-writes + kg-freshness and aggregates into one JSON report. |

## Endpoints touched

None directly. Queries SQLite database at `$DATABASE_PATH`.

## Failure modes

- DB not found: ensure `$DATABASE_PATH` or `~/.work-intelligence-mcp/data.db` exists.
- One subcomponent fails: `analyze` sets it to `null` and continues.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`
- Source skills preserved in git history

## Changelog

- 2026-07-24 — merged from wi-storage-audit, wi-dead-writes, wi-kg-freshness, wi-analyze-audit (see PLAN.md § 4).
