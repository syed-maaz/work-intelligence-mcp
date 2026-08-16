---
name: wi-git-audit
description: "Git repository audits: merge-ready, worktrees, symlinks. Subcommand-dispatch."
trigger_phrases:
  - "merge-ready branches"
  - "stale worktrees"
  - "broken symlinks"
  - "audit the git repo"
  - "git repository health"
argument-hint: "<subcommand> [args]"
allowed-tools: [Bash]
metadata:
  bucket: E-thick
  run_script: run.sh
  invocation: "bash skills/wi-git-audit/run.sh <subcommand>"
  subcommands:
    - name: merge-ready
      description: "Check if the current branch is ready for merge (clean tree, no WIP)."
      invocation: "bash skills/wi-git-audit/run.sh merge-ready"
    - name: worktrees
      description: "List all git worktrees with branch info."
      invocation: "bash skills/wi-git-audit/run.sh worktrees"
    - name: symlinks
      description: "Check for broken symlinks in skills/."
      invocation: "bash skills/wi-git-audit/run.sh symlinks"
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

# wi-git-audit

## Purpose

Git repository health checks — verify merge readiness, inspect worktrees, and detect broken symlinks.

## When to use

- `wi-git-audit merge-ready` before merging a branch
- `wi-git-audit worktrees` when you need to know active worktrees
- `wi-git-audit symlinks` when skills/ symlinks are suspected broken

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `merge-ready` | — | Check clean tree, staged commits, WIP/unborn status. |
| `worktrees` | — | List worktrees with branch, commit, and staleness. |
| `symlinks` | — | Scan for broken symlinks in skills/. |

## Endpoints touched

None.

## Failure modes

- Not in a git repo: commands will fail with git errors.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — merged from wi-merge-discipline, wi-worktree-status, wi-symlink-check (see PLAN.md § 4).
