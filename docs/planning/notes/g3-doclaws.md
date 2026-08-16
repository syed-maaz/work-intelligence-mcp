# G3 — Doc-Lie Report (T3) — 2026-08-06

Agent G3-REAP. Scope: scan `docs/` + `.planning/` for commands/skills documented but absent on disk. Ground truth = `skills/` directory (26 `wi-*` dirs) and `src/services/cypher/skill-dispatch.ts` (`SKILL_ROUTES`).

## 0. Ground truth

| Surface | Count |
|---|---|
| `skills/wi-*` dirs on disk | **26** |
| `skills/_catalog.json` (generated 2026-07-24) | **25** (stale — missing `wi-load-hang-probe`) |
| `SKILL_ROUTES` entries in skill-dispatch.ts | **29** (19 reference skill names with no on-disk dir) |
| docs §8 "The 36 wi-* skills" table | 36 listed, **25 have no matching skill dir** |

## 1. Three divergent skill inventories (the 22/25/36 claims)

| Claim | Source | Actual | Verdict |
|---|---|---|---|
| "~22 skills, all `wi-*` with get/post routes" | `.planning/wi-fault-proof-loop/DESIGN-ANNEX-NONFINAL.md:286`, `PHASE-0-PLAYBOOK.md:144,344,351`, `BUILD-PLAN-01-PHASE0.md:78` | Historical snapshot of loop-dispatchable `SKILL_ROUTES` (was ~22; now **29** entries, 18 dispatchable + 11 cli-only per ADR-051) | STALE — update to 29 |
| "count: 25" | `skills/_catalog.json` (generated 2026-07-24T13:36:59Z) | Disk has **26** dirs; `wi-load-hang-probe` added after generation | STALE — regenerate via `scripts/build-skill-catalog.mjs` (do not hand-edit count) |
| "The 36 `wi-*` skills" | `docs/docs/architecture/index.md:746,805` (§8 table, ADR-036-era) | **26** dirs; 25 listed names retired/consolidated (ADR-051 wrappers) | STALE — fixed (see §4) |

## 2. Ghost commands — documented but no matching skill on disk

### 2a. `docs/docs/architecture/index.md` §8 table — 25 ghosts

| Ghost command | Doc ref | Correct state |
|---|---|---|
| `wi-ask-topic` | index.md:826 | Retired — free-text Q&A folded into `wi-search` (AMBIGUOUS, verify) |
| `wi-blast-radius` | index.md:836 | Consolidated → `wi-code` (ADR-051) |
| `wi-bug-report` / `wi-bug-resolve` / `wi-bug-resolve-all` | index.md:855-857 | Consolidated → `wi-bug` (ADR-051) |
| `wi-check-links` / `wi-frontmatter` | index.md:874 | Consolidated → `wi-govern` (memory validation) |
| `wi-code-research` | index.md:829 | Consolidated → `wi-code` (ADR-051) |
| `wi-correlate` | index.md:845 | Consolidated → `wi-code` (ADR-051 fan-out) |
| `wi-daily-digest` | index.md:812 | Consolidated → `wi-brief` (ADR-051) |
| `wi-find-expert` | index.md:842 | Consolidated → `wi-people` (ADR-051) |
| `wi-health` | index.md:817 | Partially folded into `wi-audit` (AMBIGUOUS — no exact successor) |
| `wi-jira-analyze` / `wi-jira-report` | index.md:827,839 | Consolidated → `wi-jira` (ADR-051) |
| `wi-morning-brief` | index.md:822 | Consolidated → `wi-brief` (ADR-051) |
| `wi-palace-query` | index.md:813 | AMBIGUOUS — no direct successor documented |
| `wi-pr-review` | index.md:840 | Consolidated → `wi-code` (ADR-051) |
| `wi-save-to-ticket` | index.md:859 | Consolidated → `wi-jira` (ADR-051) |
| `wi-search-all` | index.md:814 | Superseded → `wi-search` (rename) |
| `wi-sync` | index.md:860 | AMBIGUOUS — background-sync tool, no skill successor |
| `wi-teammate` | index.md:818 | Consolidated → `wi-people` (ADR-051) |
| `wi-teams-search` | index.md:815 | Superseded → `wi-search` |
| `wi-ticket-links` | index.md:846 | Consolidated → `wi-jira` (ADR-051) |
| `wi-weekly-report` | index.md:841 | Consolidated → `wi-brief` (ADR-051) |
| `wi-who-owns` | index.md:837 | Consolidated → `wi-code` owner-lookup (ADR-051) |

### 2b. `docs/docs/development/skill-management.md` — 3 ghosts

| Ghost command | Doc ref | Correct state |
|---|---|---|
| `wi-morning-brief` | skill-management.md:8,19,25 (skill-tree diagram) | Real skill is `wi-brief` |
| `wi-newskill` | skill-management.md:53-56 | How-to example, not a live skill — flag as illustrative only |
| `wi-skills-backup` | skill-management.md:63,67 | Historical restore tarball path — not a skill |

### 2c. `docs/docs/prd/cypher-v2.0.md` — historical claim

| Claim | Doc ref | Verdict |
|---|---|---|
| "36 as of 2026-06-17" | cypher-v2.0.md:180 | Historical dated snapshot; superseded by 26 (note only) |

### 2d. Non-command false positives (excluded)

`/wi-mcp-g0..g7-*` worktree names, `/wi-foo`/`/wi-bar`/`/wi-good`/`/wi-bad` test artifacts, `/wi-dispatch-stream` API route, `/wi-router-30-intent-eval` eval label, `wi-tools.ts`/`wi-menubar/` path fragments, `/wi-unknown` placeholder. These are path/branch/eval references, not documented commands.

## 3. What is NOT fixed (ambiguous → noted, needs human decision)

1. `wi-ask-topic`, `wi-palace-query`, `wi-sync`, `wi-health` — no unambiguous successor skill; dead names remain in docs until ownership decision.
2. `.planning/wi-fault-proof-loop/*` — planning-in-progress docs; orchestrator should decide whether to refresh "~22" → 29.
3. `skills/_catalog.json` — generated artifact; regenerate with `scripts/build-skill-catalog.mjs` (do not hand-edit).
4. `docs/docs/architecture/index.md:232,319,707` "~123 skills (36 wi-*, 55 global, 32 plugin)" — claims about runtime `skill_catalog` scanner (`~/.claude/skills/` global scope), a different inventory; out of this report's scope.
5. `src/services/cypher/skill-dispatch.ts` 19 routes pointing at consolidated names — deliberate per ADR-051 Option A (workaround); G2 owns that file.

## 4. Fixes applied (obvious rot only)

- `docs/docs/architecture/index.md:746` — "The skills system (36 `wi-*` skills)" → "(26 `wi-*` skills)" + rot pointer.
- `docs/docs/architecture/index.md:805` — "The 36 `wi-*` skills, by category" → "The 26 `wi-*` skills, by category (historical 36 — see g3-doclaws.md §2a)".
