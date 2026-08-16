---
name: wi-dream-apply
description: "Apply approved proposals from a /dream report into the memory brain. Human-gated: writes memory/*.md, upserts the MEMORY.md index, mirrors to the palace, and commits each change as its own git commit (revertable). Reject items so the next dream never re-proposes them."
argument-hint: "<ids e.g. 1,3> | --all | --reject 2"
allowed-tools: [Bash]
metadata:
  bucket: A
  run_script: null
  invocation: "node scripts/dream-apply.mjs [--approve 1,3 | --all | --reject 2]"
  endpoints: ["POST /api/palace/drawer"]
  reads_tables: []
  writes_tables: []
  writes_mutating: true
  related_skills: [wi-dream, wi-update-context]
  triggers:
    - dream apply
    - apply dream
    - approve dream proposals
    - land dream items
    - reject dream proposal
  born: 2026-08-06
  last_verified: 2026-08-06
  model:
    provider: anthropic
    tier: haiku
    override: null
    rationale: "Bucket A: deterministic script does the work; the LLM only renders the per-item result lines."
---

# wi-dream-apply

## Purpose
The **APPLY** half of `/dream`. `wi-dream` proposes; this lands the approved ones.
Each approved item is written to the memory brain AND committed as its own git
commit, so a bad proposal is undone with a single `git revert`.

## When to use
- After reviewing a dream report (terminal `dream-report.md` or the WI web `/dream` page).
- `/wi-dream-apply 1,3` — apply items 1 and 3.
- `/wi-dream-apply --all` — apply every pending item.
- `/wi-dream-apply --reject 2` — reject item 2 (no file change; suppressed from future dreams).

## When NOT to use
- To GENERATE proposals → `/wi-dream`.
- To flush the current live session → `wi-update-context`.

## What it does (per approved item)
1. **add/update** → write `memory/<target>.md` (Shape-A frontmatter) · **prune** → delete it.
2. Upsert the `MEMORY.md` index line (or remove it on prune).
3. Mirror to the palace: `POST /api/palace/drawer` (room ∈ topics|decisions|annotations, idempotent). Best-effort — never blocks the memory write.
4. `git commit` that single change in the memory repo: `dream: <type> <target> (item N)`.
5. Flip the item's `status` in `dream-report.json` to `applied` (or `rejected`).

## Invocation
```
node scripts/dream-apply.mjs --approve 1,3     # or bare: node scripts/dream-apply.mjs 1,3
node scripts/dream-apply.mjs --all
node scripts/dream-apply.mjs --reject 2
Exit: 0 = ok (per-item result JSON on stdout), 1 = refused/no report
Env:  DREAM_UNATTENDED=1 → apply refuses (apply is never automatic)
```

## Undo
Each item is its own commit in the memory repo:
```
git -C <memory> revert <sha>          # undo one applied item
```

## Related
- `wi-dream` — the generate half.
- `scripts/dream-apply.mjs` — the shared apply module (also used by `POST /api/dream/apply`).

## Changelog
- 2026-08-06 — created (approved-plan two-skill design; apply half).
