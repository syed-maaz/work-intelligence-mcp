---
name: wi-dream
description: "Nightly memory-consolidation 'dream' pass. Reads the last 24h of human-typed session messages, compares against the memory brain, and PROPOSES memory changes into a gated report. Read-only: applies nothing — approve in the WI web UI /dream or run wi-dream-apply to land items."
argument-hint: "[--hours N] (default 24)"
allowed-tools: [Bash, Read]
metadata:
  bucket: D
  run_script: null
  invocation: "drives headless generate via scripts/dream-prompt.txt"
  endpoints: ["POST /api/brain/recall (optional, best-effort)"]
  reads_tables: []
  writes_tables: []
  writes_mutating: false
  related_skills: [wi-dream-apply, wi-update-context, wi-memory-compact]
  triggers:
    - dream
    - run a dream pass
    - consolidate my memory
    - what did i learn today
    - nightly memory review
  born: 2026-08-06
  last_verified: 2026-08-06
  model:
    provider: anthropic
    tier: sonnet
    override: null
    rationale: "Bucket D (digest-class synthesis): narrative pattern-finding across a day of transcripts; quality matters, volume is low."
---

# wi-dream

## Purpose
Karpathy-style "dreaming": while you're not actively working, look back over the
day's sessions, find durable preferences / corrections / new facts you *typed*, and
propose them as memory updates — so the memory brain stays fresh without polluting
live task focus. This is the **GENERATE** half. It writes a **report only**; it never
edits memory. Approving + applying is a separate, human-gated step (the WI web UI
`/dream` page, or `/wi-dream-apply`).

## When to use
- Manually, any time: `/wi-dream` — "what did I learn today worth remembering?"
- Automatically: fired at 07:00 by the launchd job `com.work-intelligence.dream`
  (with native wake-catchup — runs at first wake if the Mac was asleep at 07:00),
  which pipes `scripts/dream-prompt.txt` to a headless `claude -p`.

## When NOT to use
- To SAVE the current live session → `wi-update-context` (writes all 4 surfaces now).
- To AUDIT MEMORY.md size / prune duplicates mechanically → `wi-memory-compact`.
- To APPLY proposals from a report → `/wi-dream-apply <ids>` or the `/dream` web page.

## The three problems it solves
| Problem | Symptom without dreaming |
|---|---|
| **Split focus (chef)** | `wi-update-context` summarizes a session *while it's happening* — competes with the work |
| **Hidden patterns (coach)** | Each session judged alone; a preference in session A contradicted in B is never reconciled |
| **Stale maps** | A superseded fact (old branch convention, old editor) sits in MEMORY.md forever |

## How it works
This skill dispatches the shared generator instructions in
`scripts/dream-prompt.txt` — the single source of truth used by BOTH the manual
`/wi-dream` invocation and the nightly launchd job. Steps the generator runs:

1. **INGEST** — `bash scripts/dream-extract.sh <N>` isolates human-typed messages
   (last N hours) via the transcript's `promptSource ∈ {typed,queued}` flag. Tool
   output, assistant replies, and harness injections (task-notifications, `<admin>`,
   `<system-reminder>`) are never included — **safety constraint: user-typed only**.
2. **COMPARE** — reads `memory/MEMORY.md` + overlapping `memory/*.md` (+ optional
   `POST /api/brain/recall`), and the prior report's `status:rejected` items so it
   **never re-proposes** something you already rejected.
3. **PROPOSE** — numbered items, each with a **verbatim quote** of what you typed as
   evidence, classified `add | update | prune`, matching the memory Shape-A schema.
4. **WRITE** — `memory/.dream/dream-report.{md,json}` only. Nothing else is touched;
   the nightly driver's git-status guard hard-fails the run if it is.

## Invocation
```
Manual:   read scripts/dream-prompt.txt and follow it (or the launchd job runs it headless)
Ingest:   bash scripts/dream-extract.sh [HOURS]   # default 24
Writes:   memory/.dream/dream-report.md, memory/.dream/dream-report.json  (ONLY these)
```

## Constraints (non-negotiable)
1. **Read-only.** Only `memory/.dream/dream-report.{md,json}` may be written. Never a
   memory file, never MEMORY.md, never source.
2. **User-typed facts only.** Evidence = verbatim quote of a `promptSource:typed|queued`
   message. Never tool output, never an assistant reply, never your own reasoning.
3. **Durable only.** Propose lasting preferences/corrections/decisions/facts — not
   one-off task chatter or anything already in memory. 0 items is a valid honest result.

## Output
Prints `dream-report.md` and the pending-item count. Review, then:
`/wi-dream-apply 1,3` to land items 1 and 3, or Approve/Reject in the WI web UI `/dream`.

## Related
- `scripts/dream-prompt.txt` — shared generator instructions (source of truth).
- `scripts/dream-extract.sh` — the human-typed extractor (INGEST step).
- `wi-dream-apply` — the human-gated APPLY half (writes memory + palace + git commits).
- `wi-update-context` — the in-band flush this complements.

## Changelog
- 2026-08-06 — created (approved-plan two-skill design; generate half).
