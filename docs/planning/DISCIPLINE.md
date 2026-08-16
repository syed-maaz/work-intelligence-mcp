# WI DISCIPLINE — every model, every session, every agent

Universal contract. Applies to all agents/sessions working on this repo, any model, any framework (opencode, Claude Code, subagents, Cypher sessions, inline agents).

## 1. Definition of Done (all three, no exceptions)

**A task is DONE only when:**

- [ ] **E2E PASSED** — full E2E suite for the scope ran and passed.
- [ ] **15 SCENARIOS PASSED** — 15 real-world scenarios exercised, documented with PASS/FAIL, covering:
      1. Happy path (real data)
      2. Empty result set
      3. Missing table/column (graceful degrade)
      4. Timeout / slow upstream
      5. Partial failure mid-batch
      6. Duplicate rows / idempotency
      7. Long-running input (large payload)
      8. Stale data (T-7d, T-30d)
      9. Permission/401/403 errors
      10. Malformed payload / bad JSON
      11. Concurrent writers (two processes same DB)
      12. Zero-data schema-only DB
      13. Flag off / disabled feature path
      14. Retry-exhausted path (DLQ/abort)
      15. Rollback path (dry-run → apply → verify)
- [ ] **5-AGENT REVIEWED** — ≥5 independent reviewers (different roles/models) reviewed the diff. Verdicts recorded. Zero FAIL before merge.

## 2. Streaming retry discipline

- Agent call fails / times out / returns empty → **wait 10 seconds → retry**.
- Up to 5 attempts. Then commit `BLOCKED: <reason>` note and stop. Never silently give up, never silently continue without the note.

## 3. Hard rules

- No task marked done without DoD.
- No merge to master without 5-agent review pass + E2E + scenarios.
- No silent zeroes: if a metric can't be computed, print "NO TRACKING — <why>" loudly.
- Prod DB read-only unless explicit orchestration approval. Dev DBs are sandboxes.
- Commit prefix `worktree/<task>:` on branches. Typecheck + lint before every commit.

## 4. Where this lives

- Repo: `docs/planning/DISCIPLINE.md`
- Contract: `docs/planning/MULTIAGENT-EXECUTION-2026-08-06.md`
- Enforced by orchestrator at merge gates; agents self-enforce during work.
