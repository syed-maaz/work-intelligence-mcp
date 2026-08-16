---
name: wi-vault
description: "Obsidian vault: annotate, todo. Subcommand-dispatch."
trigger_phrases:
  - "annotate obsidian"
  - "obsidian todo"
  - "vault operations"
argument-hint: "<subcommand> [args]"
allowed-tools: [Bash]
metadata:
  bucket: E-thick
  run_script: run.sh
  invocation: "bash skills/wi-vault/run.sh <subcommand>"
  subcommands:
    - name: annotate
      description: "Open vault note for human annotation below separator."
      invocation: "bash skills/wi-vault/run.sh annotate <name> | list"
    - name: todo
      description: "List vault notes needing annotation."
      invocation: "bash skills/wi-vault/run.sh todo [days]"
  endpoints: []
  reads_tables: []
  writes_tables: []
  writes_mutating: true
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

# wi-vault

## Purpose

Obsidian vault annotation workflow — find notes needing human corrections and open them at the right spot for fast annotation.

## When to use

- `wi-vault todo` to see which vault notes need attention
- `wi-vault annotate <name>` to open a specific note for annotation

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `annotate` | <name> \| list | Open vault note below annotation separator. |
| `todo` | [days] | List unannotated notes changed within N days. |

## Endpoints touched

None directly. Reads/writes Obsidian vault files.

## Failure modes

- `OBSIDIAN_VAULT_PATH` not set: set in .env.
- Note missing annotation zone: it's auto-generated without user section.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — merged from wi-annotate, wi-vault-todo (see PLAN.md § 4).
