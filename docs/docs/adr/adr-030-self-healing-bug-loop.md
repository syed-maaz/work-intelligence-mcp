---
sidebar_label: "ADR-030: Self-Healing Bug Loop"
sidebar_position: 30
---

# ADR-030: Self-Healing Bug Loop for WI Itself

**Status**: Proposed
**Date**: 2026-05-30
**Deciders**: Maaz
**Scope**: Work Intelligence MCP (this repo only — bridge, agents, web UI, sync pipelines). Not example-service/operations.
**Pipeline stages**: Capture=Fetch, Dedupe=Process, Investigate=Analyze, Propose=Propose
**Related**: [ADR-013](./adr-013-intelligent-bug-investigation.md) (investigates example-service Jira tickets — different concern), [ADR-017](./adr-017-always-on-agent-architecture.md), [ADR-024](./adr-024-unified-brain.md), [ADR-027](./adr-027-code-graph-indexer-scheduling.md)

---

## The one-paragraph version (for non-technical readers)

Right now, when something inside WI breaks — an agent crashes, the bridge throws an error, the web UI hits an exception — the failure either disappears into the terminal logs or shows up as a vague red badge. A human has to notice, reproduce, dig through logs, find the cause, and fix it. **This ADR proposes that WI watches itself.** Every error gets automatically recorded as a "bug record," similar errors are merged so we don't get spammed, the system uses its own Brain to investigate the likely cause, and — if it's confident — it drafts a fix as a pull request. For changes inside WI itself that are small, low-risk, and pass their smoke test, the system **may auto-merge** to a non-protected branch (never `main`/`master`). For anything touching the connected repos (`./repos/example-service`, `./repos/operations`) or anything classified as critical, Maaz reviews and approves manually. The machine does the boring detective work; the human stays in the loop wherever the blast radius leaves WI's own boundary.

---

## Context

WI today has nine always-on agents (ADR-017), about eighty HTTP endpoints, a React web UI, and several browser-driven sync pipelines (Teams, Outlook, Jira). When any of them fail:

- **Agent crashes** are visible at `/api/agents/health` but only if you look. There's no triage, no history, no investigation.
- **Bridge exceptions** land in stderr. If nobody is tailing the log, they vanish.
- **UI errors** are caught locally by the existing `<ErrorBoundary>` at `web/src/components/shell/ErrorBoundary.tsx` (which `console.error`s and shows a recovery card per route — U-8) but are never persisted or sent to the bridge. There is no `window.onerror` / `unhandledrejection` for non-React errors. Both gaps are addressed by extending the existing boundary, not by adding a parallel one.
- **Sync hangs** (e.g. the known Teams scrape that blocks Outlook for 3+ minutes) silently degrade the system.

The result: WI accumulates silent breakage. By the time Maaz notices "search results look stale" or "the digest is empty," the original error has been gone from stderr for hours.

Meanwhile, the Brain (ADR-024) already exists and can answer questions like *"what's the likely cause of error X in file Y?"* with code-graph context, recent commits, and recall of past similar bugs. The code-graph indexer (ADR-027) already maps blast radius for files in this repo. The smoke-test framework (`.claude/rules/smoke-tests.md`) can verify whether a proposed fix actually works.

Every component for self-healing exists in isolation. They're not yet wired into a loop.

---

## Decision

Build a four-stage **Capture → Dedupe → Investigate → Propose** loop, scoped strictly to WI's own runtime.

The loop runs continuously, in the background. Default disposition is **propose, never apply**: a draft PR is generated and Maaz reviews it.

**Narrow auto-merge exception (WI repo only).** A proposed fix MAY auto-merge without human review when **all** of the following hold:

1. The bug's `source` is in the WI repo (`bridge | agent | web-ui | sync`) and the proposed change touches only files under `src/**` or `web/src/**` — never `./repos/**`, never `src/db/schema.ts` or any migration, never `web-server.js`'s agent boot block, never `package.json` / lockfiles, never `.env*`, never `.claude/**`.
2. Severity is `low` or `medium` (see Severity rules below). `high` always requires human approval.
3. Brain confidence ≥ 0.9, `files_to_change` ≤ 2, lines changed ≤ 20.
4. `git apply --check` succeeds against the current target branch HEAD.
5. Both `npm run typecheck` and the relevant `npm run smoke:*` pass on the candidate branch.
6. The target branch is **not** `main` / `master`. Auto-merge always lands on a side branch named `auto/bug-<id>-<fingerprint:8>`. The hard rule "never push to `main`/`master`" from CLAUDE.md is preserved.
7. A 24-hour cooldown is not active (see "Self-correcting" below).

If any condition fails, the bug downgrades to "needs human" and surfaces as a draft PR for review. Auto-merged commits carry the prefix `auto-fix:` and a `Auto-Merged-By: BugInvestigatorAgent` trailer so they are trivially `git log --grep`-able and revertable as a batch.

**Self-correcting.** If Maaz reverts an auto-merged commit, auto-merge is disabled globally for 24 hours and the offending fingerprint is permanently flagged `auto-merge: never`. Rate limit: at most 1 auto-merge per hour, 5 per day, regardless of confidence.

The four stages mirror the existing Fetch → Process → Analyze → Propose pipeline constraint of this codebase, so the architecture is consistent with the rest of the system.

---

## Flow chart

```
┌─────────────────────────────────────────────────────────────────────┐
│                          1. CAPTURE                                 │
│                                                                     │
│   Bridge stderr        Agent loop          Web UI                   │
│   (uncaughtException,  (per-tick           (window.onerror,         │
│    unhandledRejection) try/catch)          React error boundary)    │
│           │                  │                    │                 │
│           └──────────────────┴────────────────────┘                 │
│                              │                                      │
│                              ▼                                      │
│                  POST /api/bugs/report                              │
│                  { source, errorName, message,                      │
│                    stack, file, line, context }                     │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          2. DEDUPE                                  │
│                                                                     │
│   fingerprint = sha256(source + errorName +                         │
│                        normalizedMessage + topFrame)                │
│                                                                     │
│   ┌─────────────────────┐         ┌──────────────────────────┐      │
│   │ Already in `bugs`?  │  yes →  │ occurrence_count++       │      │
│   │ (UNIQUE fingerprint)│         │ last_seen_at = now()     │      │
│   └──────────┬──────────┘         │ — done, no investigation │      │
│              │ no                 └──────────────────────────┘      │
│              ▼                                                      │
│   INSERT new row, status='new'                                      │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ (only new bugs continue)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       3. INVESTIGATE                                │
│                                                                     │
│   BugInvestigatorAgent (always-on). Polls:                          │
│     SELECT * FROM bugs                                              │
│      WHERE status='new'                                             │
│        AND source != 'bug-investigator'   ← recursion guard         │
│                                                                     │
│   For each new bug, gathers evidence:                               │
│     • Stack trace + file:line                                       │
│     • git log --since=<bug.first_seen_at - 24h>                     │
│     • Code-graph blast radius for the offending file (ADR-027)      │
│     • Brain recall: similar past bugs in `bug_investigations`       │
│                                                                     │
│   Calls Brain.get_decision({                                        │
│     question: "what caused <error> at <file:line>?",                │
│     evidence: [...above]                                            │
│   })                                                                │
│                                                                     │
│   Writes to `bug_investigations`:                                   │
│     • root_cause (text)                                             │
│     • files_to_change (json array)                                  │
│     • confidence (0..1)                                             │
│     • suggested_patch (text, optional)                              │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     4. PROPOSE / ALERT                              │
│                                                                     │
│   Investigation → branch `auto/bug-<id>-<fp:8>`                     │
│                  → git apply --check → typecheck → smoke            │
│                                                                     │
│              ┌─────────────────────────────────────┐                │
│              │ AUTO-MERGE gate (all must hold):    │                │
│              │  • source ∈ WI repo                 │                │
│              │  • files ⊆ src/** or web/src/**     │                │
│              │    (never schema/boot/lockfiles)    │                │
│              │  • severity ∈ {low, medium}         │                │
│              │  • confidence ≥ 0.9                 │                │
│              │  • files_to_change ≤ 2, lines ≤ 20  │                │
│              │  • smoke + typecheck PASS           │                │
│              │  • not on main/master               │                │
│              │  • rate limit + cooldown OK         │                │
│              └──────────┬──────────────────────────┘                │
│                         │                                           │
│              ┌──────────┴──────────┐                                │
│              │ all pass            │ any fail                       │
│              ▼                     ▼                                │
│   merge to side branch    POST /api/pr/create                       │
│   commit prefix:          { dry_run: true }                         │
│     `auto-fix:`           → draft PR for Maaz                       │
│   trailer:                + surface in `/bugs` page                 │
│     Auto-Merged-By: …     + Atlas alert feed                        │
│                           + homepage banner if severity=high        │
│                                                                     │
│   Connected-repo bugs (./repos/**) NEVER reach the auto-merge       │
│   gate — always draft PR for human approval.                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How each stage works (plain-English version)

### 1. Capture — "Don't let errors disappear"

Wherever code can crash, we add a small hook that POSTs the error to `/api/bugs/report`. Three places:

- **Bridge**: `process.on('uncaughtException')` and `process.on('unhandledRejection')` in `web-server.js`.
- **Agents**: each agent's tick is wrapped in try/catch; on error, it records the bug *and* keeps the agent alive (today, an agent crash kills the whole agent until restart).
- **Web UI**: extend the existing `<ErrorBoundary>` (`web/src/components/shell/ErrorBoundary.tsx`) — its `componentDidCatch` adds a `POST /api/bugs/report` alongside the existing `console.error`. Add `window.onerror` + `window.addEventListener('unhandledrejection', ...)` in `web/src/main.tsx` for non-React errors.

The error report carries enough context to investigate later: source, error name, message, stack, file, line, and a small payload of "what was happening" (which route, which agent tick, which user action).

### 2. Dedupe — "Don't drown in duplicates"

The first time a system like this gets built, the most common failure mode is *one bad import causes 10,000 bug records in five minutes*. We prevent that with a **fingerprint**: a hash of the error's identity (type + cleaned message + top stack frame). Same fingerprint → same row, with a counter incrementing. Different fingerprint → new row.

This means the `bugs` table is small and meaningful: one row per *kind* of bug, not one per occurrence.

### 3. Investigate — "Use the Brain we already built"

A new always-on agent, `BugInvestigatorAgent`, watches for bug rows with `status='new'`. For each one, it gathers evidence the same way a senior developer would:

- The stack trace tells you *where*.
- `git log` since just before the bug first appeared tells you *what changed*.
- The code-graph (ADR-027) tells you *what else this file affects*.
- Past investigations in `bug_investigations` tell you *if we've seen this shape before*.

It bundles all that as evidence into a Brain `get_decision` call, which returns a structured answer: likely root cause, which files to change, confidence score, and (if confident enough) a suggested patch.

### 4. Propose — "Draft the fix; auto-merge only when it's truly safe"

If the Brain is confident **and** the proposed change is small **and** the relevant smoke test exists, the system creates a candidate branch, applies the patch, runs typecheck + smoke against it, and then chooses one of two paths:

- **Auto-merge path** (WI repo only, all gates in the Decision section met): the commit lands on the side branch `auto/bug-<id>-<fingerprint:8>` with prefix `auto-fix:` and the `Auto-Merged-By: BugInvestigatorAgent` trailer. Never on `main`/`master`. Maaz can revert any of them with a single `git revert` — and a revert auto-disables the loop for 24h.
- **Draft PR path** (everything else — connected repos, high severity, confidence below the gate, blast radius too large, smoke missing): uses the existing `/api/pr/create` endpoint with `dry_run: true` (default, enforced by smoke-bridge.sh check #6). Maaz reviews and approves manually.

If the Brain isn't confident enough even for a draft PR, the bug surfaces in:

- A new `/bugs` page in the web UI (list, dedup view, investigation notes, mark-resolved button)
- The Atlas alert feed (so it shows up where Maaz already looks)
- A homepage banner if severity is high

**Connected-repo bugs (`./repos/example-service`, `./repos/operations`) never reach the auto-merge path** — regardless of confidence. Cross-repo changes always require human approval.

---

## Why this is safe

Five guardrails make this not-a-foot-gun:

1. **Hard repo boundary.** Auto-merge is structurally impossible outside WI itself. The gate checks `bug.source ∈ WI repo` AND `files_to_change ⊆ src/** | web/src/**` AND `not main|master`. Connected-repo (`./repos/**`) bugs always go through the dry-run PR path — same as today. The bridge smoke test asserts the gate cannot be bypassed; if anyone removes the check, smoke fails before merge.

2. **Recursion guard is query-shaped, not tag-shaped.** The investigator's poll is `SELECT * FROM bugs WHERE status='new' AND source != 'bug-investigator'`. If the agent itself crashes, its row is recorded with `source='bug-investigator'` and the WHERE clause excludes it from being investigated. A separate path surfaces those rows in `/bugs` so they're still visible to Maaz — they just never enter the loop. Without this query-level filter, tagging the source alone would not break the recursion.

3. **Self-correcting on revert.** Every auto-merged commit carries the `auto-fix:` prefix and `Auto-Merged-By: BugInvestigatorAgent` trailer. If Maaz reverts one, a post-receive check disables auto-merge for 24h and writes the offending fingerprint to a `auto_merge_blocklist` table. The next time the same fingerprint appears, it bypasses the auto-merge gate forever (only a draft PR is generated). One bad fix cannot become a pattern.

4. **Rate-limited.** At most 1 auto-merge per hour, 5 per day, regardless of how confident the Brain is. A bug spree cannot rewrite half the codebase overnight even in the worst case.

5. **Severity-gated alerts.** Not every bug becomes a banner. The `/bugs` page is always there for browsing; the homepage banner only fires for `severity=high` (which also disables auto-merge for that bug). Severity is a function of fingerprint occurrence rate × source criticality — defined under "Severity rules" below.

---

## What changes in the codebase

**New (additive — nothing existing breaks):**

- Schema bump (`CURRENT_SCHEMA_VERSION` 51 → 52, lands in Phase A): two new tables, `bugs` and `bug_investigations`, plus a small `auto_merge_blocklist` table for the self-correcting revert path.
- New endpoints `/api/bugs/report` (POST), `/api/bugs` (GET list), `/api/bugs/:id` (GET detail), `/api/bugs/:id/resolve` (POST).
- New always-on agent `BugInvestigatorAgent` registered in the agent boot block. Reuses existing `withAgentTick` wrapper for crash isolation.
- Extension to the existing `withAgentTick` wrapper (`web-server.js`, see ADR-027): its catch arm posts to `/api/bugs/report` before the existing `flaky → degraded` escalation. **No new agent base class** — every registered agent inherits capture transparently.
- Extension to `/api/pr/create` (Phase C only): accept `repo: 'work-intelligence-mcp'` as a valid target. Today it's wired for `example-service`/`operations` only. The `dry_run` default and the auto-merge gate are enforced server-side, not by the caller.
- New web UI page `/bugs`.
- Capture hooks in `web-server.js` (`uncaughtException`, `unhandledRejection`) and `web/src/main.tsx` (`window.onerror`, React error boundary).

### Schema (Phase A migration → v52)

Both tables ship in Phase A's migration even though `bug_investigations` is unused until Phase B. This keeps the schema bump atomic, lets Phase A's `/bugs` detail page render an empty "Investigation" tab without conditional UI, and avoids a second `CURRENT_SCHEMA_VERSION` bump for Phase B.

```sql
CREATE TABLE IF NOT EXISTS bugs (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN
    ('bridge','agent','web-ui','sync','bug-investigator')),
  error_name TEXT NOT NULL,
  message TEXT NOT NULL,
  top_frame TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','investigating','proposed','auto-merged','resolved','wont-fix')),
  severity TEXT NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low','medium','high')),
  context_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_bugs_status ON bugs(status);
CREATE INDEX IF NOT EXISTS idx_bugs_last_seen ON bugs(last_seen_at);

CREATE TABLE IF NOT EXISTS bug_investigations (
  id INTEGER PRIMARY KEY,
  bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  root_cause TEXT NOT NULL,
  files_to_change TEXT NOT NULL,        -- JSON array
  lines_changed INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  suggested_patch TEXT,
  decided_at TEXT NOT NULL,
  brain_decision_id INTEGER REFERENCES brain_decisions(id)
);

CREATE TABLE IF NOT EXISTS auto_merge_blocklist (
  fingerprint TEXT PRIMARY KEY REFERENCES bugs(fingerprint),
  reason TEXT NOT NULL,                 -- 'reverted' | 'manual'
  blocked_at TEXT NOT NULL
);
```

The `source='bug-investigator'` enum value is the same value the recursion guard's `WHERE` clause filters on — making the constraint real in the schema, not just in prose.

### Fingerprint normalization (deterministic, applied before hashing)

Without explicit normalization, JS error messages embed line numbers, request IDs, and absolute paths that mutate per-occurrence — so the fingerprint would be per-occurrence and dedup would do nothing. Rules:

1. Replace runs of digits of length ≥ 3 with `<N>` (filters request IDs, ports, line numbers in messages).
2. Replace UUIDs and SHA-shaped hex (≥ 8 chars) with `<HASH>`.
3. Replace absolute paths under `/Users/`, `/home/`, `C:\Users\` with `~`.
4. Trim whitespace, lowercase the leading verb (`Cannot read…` ≡ `cannot read…`).
5. **Top frame** = first stack line where `file != node_modules` AND the frame is not inside a known wrapper (`withAgentTick`, the bridge's express error middleware, the React error boundary). Otherwise two unrelated bugs hashed at the same wrapper site collide.

Final: `fingerprint = sha256(source + '|' + errorName + '|' + normalizedMessage + '|' + topFrame)`.

### Smoke-test gate definition (Propose stage)

The Propose stage's "smoke tests defined" gate means: at least one assertion in `scripts/smoke-bridge.sh` or `scripts/smoke-ui.mjs` references a path in `files_to_change` (substring match on file basename). If no existing smoke assertion covers the touched code, the bug **never auto-merges and never generates a draft PR** — it surfaces in `/bugs` for human triage. This forces every auto-fixable surface to be smoke-covered first.

### Severity rules

- `high` → fingerprint occurrence_count ≥ 10 within 1h, OR source ∈ {`agent`} with status crash-loop, OR matches a hand-curated "critical paths" allowlist (e.g. `web-server.js` boot, schema migration). High severity always disables auto-merge.
- `medium` → occurrence_count ≥ 5 within 24h.
- `low` → otherwise.

### Propose-stage prerequisites (Phase C only)

1. `/api/pr/create` extended to accept `repo: 'work-intelligence-mcp'` (additive change, behind the existing `dry_run` and auto-merge gates).
2. The investigator renders `suggested_patch` to a unified diff and runs `git apply --check` against `HEAD` of the target branch before doing anything else. On apply-failure the bug downgrades to "needs human" and surfaces in `/bugs` instead — never a half-applied patch, never a force-push.
3. Branch naming: `auto/bug-<id>-<fingerprint:8>`. Never reuses an existing branch.
4. After merge (auto-merge path): the bridge subscribes to a `post-receive` hook that watches for `git revert` on `auto-fix:` commits and triggers the 24h cooldown.

### Observability

- One stderr line per capture: `[Bugs] capture: source=bridge name=TypeError fp=ab12cd34 (new|+1)`.
- One stderr line per investigation: `[BugInvestigator] tick: bug=<id> conf=0.83 files=2 → proposed|auto-merged|surfaced`.
- New `/api/system-health.bugs` block exposing: `total`, `new`, `investigating`, `proposed`, `auto_merged_24h`, `resolved_24h`, `top_fingerprints` (top 5 by `occurrence_count`), `investigator_status` (`ready` | `degraded` | `crashed`), `auto_merge_cooldown_until` (nullable timestamp).
- Smoke check (`smoke-bridge.sh`) asserts the block exists, `total >= 0`, and rejects an attempted auto-merge to `main` (negative test).

**Smoke tests added:**

- `smoke-bridge.sh`: dedup works on second POST to `/api/bugs/report` with same fingerprint; `/api/system-health.bugs` block present; auto-merge gate refuses `main`/`master`; auto-merge gate refuses `repo` outside WI.
- `smoke-ui.mjs`: `/bugs` renders, lists at least the seed row, "Investigation" tab present (empty in Phase A).

**No changes to:**

- The Brain (it already exposes `get_decision`).
- `main`/`master` push policy (auto-merge always lands on side branches).
- Existing agents' code (each gets capture via the existing `withAgentTick` wrapper, transparently).

---

## What we're explicitly NOT doing in v1

- **Auto-merging anything outside WI itself.** Bugs traceable to `./repos/example-service` or `./repos/operations` always become dry-run PRs for human approval. No exception.
- **Auto-merging high-severity bugs even within WI.** `severity=high` always requires human approval, regardless of confidence.
- **Cross-repo fixes.** This ADR is WI-only. Bugs in example-service/operations remain ADR-013's territory.
- **Production telemetry from external services** (e.g. third-party error-aggregation SaaS). WI is a personal local system; we capture in-process only.
- **Fine-tuning the Brain on bug data.** Investigations are stored and recalled, but no model retraining.

---

## Phasing

A natural four-phase rollout, smallest-useful-thing first. Each phase is shippable on its own merits.

| Phase | Delivers | Useful even if next phase never ships? |
|---|---|---|
| **Phase A** — Capture + Dedupe + `/bugs` page. Schema v52 lands here (both tables). | A self-monitoring WI: every error visible, deduped, browsable. Zero AI risk. | **Yes.** This alone replaces "tail the stderr and hope." |
| **Phase B** — `BugInvestigatorAgent` writes findings to `bug_investigations`. No PR generation yet. | Each bug now has an AI-generated root-cause analysis attached. Maaz reads it, decides what to do. | **Yes.** This is "AI-assisted triage" without auto-action. |
| **Phase C** — Generate dry-run PRs for high-confidence + small-blast-radius bugs. **No auto-merge yet** — every PR requires human approval. | Closes the loop for the conservative case: bug → investigation → draft PR → human approval. | **Yes.** This is the same self-healing system minus the auto-merge gate — already a meaningful reduction in triage cost. |
| **Phase D** — Enable the auto-merge gate (WI-only, low/medium severity, all gates from the Decision section). Adds `auto_merge_blocklist`, revert-cooldown post-receive hook, and rate limiter. | Closes the loop for the truly safe case: small WI bugs fix themselves while Maaz sleeps. | This is the ambitious part. Only worth doing once Phase C has run for ≥ 1 sprint with measured PR-acceptance rate ≥ 80%. |

**Schema note.** Both `bugs` and `bug_investigations` ship in Phase A's migration even though `bug_investigations` is unused until Phase B. This keeps the schema bump atomic and avoids a second `CURRENT_SCHEMA_VERSION` bump for Phase B. `auto_merge_blocklist` also lands in v52 even though it's only populated from Phase D — same rationale.

Phase A is shippable in a single week. Phases B and C are each their own phase. Phase D is gated behind Phase C's measured accuracy and should not be planned until that signal exists.

---

## Open questions

- **Confidence thresholds (0.8 for draft PR, 0.9 for auto-merge).** Picked from existing `runDecision` calibration but not yet validated against bug data. Will need tuning after Phase B produces a sprint of investigations.
- **Rate limit (1/hour, 5/day).** Conservative default for v1. Easier to relax later than to tighten after a bad day. Revisit after Phase D has run for ≥ 2 sprints with no reverts.
- **UI bug capture in production-like deploys.** The web UI today only runs on Maaz's machine. If WI is ever shared, we'll need PII scrubbing on captured errors before they leave the browser.
- **Severity threshold tuning.** The "occurrence_count ≥ 10 in 1h" trigger for `high` is a guess. Refine after Phase A produces a week of real data.
- **Revert detection.** Phase D's post-receive hook is the cleanest way to detect a reverted `auto-fix:` commit, but a polling reconciler against `git log --grep=auto-fix:` is a viable fallback if the hook is fragile. Pick during Phase D planning.

---

## References

- [ADR-013: Intelligent Bug Investigation Engine](./adr-013-intelligent-bug-investigation.md) — investigates example-service Jira tickets, not WI itself. Different scope but reusable Brain patterns.
- [ADR-017: Always-On Agent Architecture](./adr-017-always-on-agent-architecture.md) — the agent framework `BugInvestigatorAgent` plugs into.
- [ADR-024: Unified Brain](./adr-024-unified-brain.md) — `get_decision` powers the investigation step.
- [ADR-027: Code Graph Indexer Scheduling](./adr-027-code-graph-indexer-scheduling.md) — provides blast-radius evidence.
- [`.claude/rules/smoke-tests.md`](../../../.claude/rules/smoke-tests.md) — the dry-run PR gate this ADR depends on.

---

## Review Findings — 2026-05-30

> Independent review against the live codebase surfaced two factual errors (corrected inline above), one process gap (not in `adr/index.md`), and seven design holes worth resolving before any code lands. Status remains **Proposed**; this section adds the deltas needed before Phase A planning.

### Inline corrections already applied

- **Agent count** — was "eight"; live count is **nine** (`web-server.js` `registerAgent` calls: OutlookWatcher, TeamsBadgeWatcher, ChangeWatcher, OrchestratorAgent, MeetingPrepAgent, CorrelationAgent, PromptEvolution, ResearchCachePrune, CodeGraphIndexer). Fixed in Context.
- **UI capture** — was "a `window.onerror` handler doesn't exist" implying no error boundary either. Live state: `<ErrorBoundary>` exists (`web/src/components/shell/ErrorBoundary.tsx`, U-8) and wraps routes in `App.tsx`. It catches and `console.error`s but never POSTs. Capture stage is now framed as **extend** the existing boundary, not **add** one. Fixed in Context and § Capture.

### Design holes to close before Phase A code

| # | Hole | Why it matters | Resolution to bake into the design |
|---|---|---|---|
| 1 | **Severity windows have no data model** | The rules `≥10 in 1h` (high) and `≥5 in 24h` (medium) cannot be computed from `bugs.occurrence_count + last_seen_at` alone — those collapse all history to a single counter and timestamp. | Add a small `bug_occurrences(bug_id, seen_at)` ring buffer in the Phase A migration, or a JSON ring in `context_json`. Severity becomes a real query, not a guess. |
| 2 | **Dedupe is SELECT-then-INSERT under burst load** | Concurrent ticks can both pass the `Already in bugs?` check and double-insert. | Specify the dedupe write as a single `INSERT ... ON CONFLICT(fingerprint) DO UPDATE SET occurrence_count = occurrence_count + 1, last_seen_at = excluded.last_seen_at` statement. |
| 3 | **Auto-merge rate limits are ephemeral** | "1/hour, 5/day" with in-memory counters resets on every bridge restart. A bad week could ship dozens of auto-merges before any limiter notices. | Persist auto-merge events as rows (either `bugs.status='auto-merged'` history or a small `auto_merge_audit(merged_at, bug_id, fingerprint)` table). The rate limiter queries it. |
| 4 | **Revert detection via `post-receive` is wrong default** | WI runs as `npm run web:bridge` on a local clone — there is no git server to install a hook on. | Make polling primary: every 60s, `git log --grep='^auto-fix:' main..HEAD` (or against the `auto-fixes` branch) and reconcile. Hook stays as a Future Extension. |
| 5 | **Path to `master` is unspecified** | Auto-merge lands on side branch `auto/bug-<id>-<fp:8>`. No statement on how those reach the daily branch. Without a policy, side branches accumulate forever. | Pick one explicitly: (a) collect into a long-lived `auto-fixes` branch + weekly human merge, (b) auto-open dry-run PRs from the side branch into `master` with no further auto-action, or (c) drop "merge to side branch" entirely and downgrade Phase D to "auto-open PR, no auto-merge". Recommend (b). |
| 6 | **Brain budget gate missing** | Each new fingerprint triggers `get_decision` (Anthropic). A bug storm with high fingerprint diversity bypasses dedup and spends real money. The existing `BRAIN_USER_DAILY_CALLS` / `brain_user_budget_ledger` (added Phase 69-05) is not referenced. | Investigator routes through `src/services/brain/budget.ts` with a dedicated bucket (e.g. `bug-investigator`). Add `BUG_INVESTIGATOR_MAX_PER_HOUR` env var. Skip investigation (downgrade to surface-only) when the bucket is exhausted. |
| 7 | **Vite-minified UI fingerprints will collapse** | The "skip wrapper frames; use the first non-wrapper frame" rule depends on readable function names. Vite production builds mangle them — many unrelated UI bugs hash to the same minified name and over-dedup. | Phase A captures only in dev/preview builds. Phase B adds source-map resolution at capture time before extending to production builds. |
| 8 | **Allowlist gaps for auto-merge** | Excludes `src/db/schema.ts`, migrations, `web-server.js` boot, `package.json`, lockfiles, `.env*`, `.claude/**`. Also high-risk and not listed: `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `.env.example`, `scripts/smoke-*.sh`. | Extend allowlist to exclude all of the above. **`scripts/smoke-*.sh` is critical** — auto-merging a smoke regression breaks the gate that protects every other auto-merge. |
| 9 | **No global kill-switch** | Cooldown only handles one bad commit. A bad week needs a single off-button. | Add `BUG_INVESTIGATOR_ENABLED=0` and `BUG_AUTO_MERGE=0` env vars, checked at agent registration and at the auto-merge gate respectively. Document in `CLAUDE.md` Environment block. |
| 10 | **Recursion guard is source-tag-only** | `WHERE source != 'bug-investigator'` stops the investigator's own crash from re-entering the loop. Doesn't stop: investigator-induced patch → agent crash with `source='agent'` → another investigation. | Add `investigation_attempts INTEGER` per bug (or count investigations in `bug_investigations`) and cap at 3. After three attempts, the bug stays in `/bugs` for human triage permanently. |
| 11 | **Blast-radius dependency** | The investigator gathers blast-radius as evidence (Investigate stage). `blast-radius-alert.ts` had a phantom-column bug (now fixed in ADR-027 v2 commit `aa5ae2a`). Callout: investigator must use the post-fix query path; if a regression reintroduces the bug, evidence quality collapses silently. | Smoke check that blast-radius returns non-zero `impactedCount` for a known importer. ADR-027 v2 will also tighten this. |

### Process gaps

- **ADR-030 is not listed in `docs/docs/adr/index.md`.** Per the index's own rule ("Every ADR has a `**Status**:` line in its header"), it should appear in the table the moment it's filed. Fixed in this commit.
- **Tracker ID.** Per the lesson from ADR-028's broken `REFACTOR-002` cross-ref, this ADR is tracked as a future post-graphify-style ledger entry in `.planning/STATE.md`, not a `REFACTOR-NNN` slot.

### Refined phasing recommendation

Phase D (auto-merge) was approved earlier in the design conversation with seven hard gates. The review's strongest substantive concern is **#5 — path to master** — which would, on a strict reading of "never push to `main`/`master`", make Phase D's "auto-merge to side branch" a dead end (the fix never reaches the running bridge). Two ways to honor that and still ship the loop:

- **Option α (recommended):** Collapse Phase D into Phase C — every fix is a draft PR, full stop. Auto-merge gate is replaced with auto-PR-with-priority-label. Maaz merges; the human stays in the loop on every change but the discovery + diff + smoke + branch are all automatic. This matches the user's hard rule literally.
- **Option β:** Keep Phase D as-is but redefine the merge target: auto-merge to a long-lived `auto-fixes` branch, then run a Sunday-morning batch merge job that PRs `auto-fixes` → `master` for human review. Auto-merge means "merged to a tracked branch", not "merged to running code."

Pick at Phase D planning time, not before. Don't enable Phase D until Phase C has run for ≥ 1 sprint with measured PR-acceptance ≥ 80% **and** Phase B has run for ≥ 1 week with no Brain-budget incidents.

### Updated Phase A scope (concrete)

Phase A as originally written: Capture + Dedupe + `/bugs` page + schema. Refined deliverables in light of the holes above:

1. **Schema v52** — `bugs` (with `INSERT ... ON CONFLICT DO UPDATE`), `bug_occurrences` (ring buffer for severity windows), `bug_investigations` (empty until Phase B), `auto_merge_blocklist` + `auto_merge_audit` (empty until Phase D).
2. **Capture** — `process.on('uncaughtException')` + `unhandledRejection` in `web-server.js`; `withAgentTick` catch arm POSTs to `/api/bugs/report` (alongside its existing `flaky → degraded` escalation); `<ErrorBoundary>.componentDidCatch` POSTs; `window.onerror` + `unhandledrejection` in `web/src/main.tsx`.
3. **Endpoints** — `POST /api/bugs/report`, `GET /api/bugs`, `GET /api/bugs/:id`, `POST /api/bugs/:id/resolve`, `/api/system-health.bugs` block.
4. **Web UI** — `/bugs` page (list, dedup view, resolve button, "Investigation" tab placeholder showing "Not investigated yet — enable Phase B").
5. **Smoke** — `smoke-bridge.sh` asserts `/api/bugs/report` deduplicates on second POST with same fingerprint, `/api/system-health.bugs.total >= 0`, recursion guard query excludes `source='bug-investigator'`. `smoke-ui.mjs` asserts `/bugs` renders.
6. **Kill-switch** — `BUG_INVESTIGATOR_ENABLED` env var (Phase A respects it even though the investigator doesn't exist yet).

### Refined flow diagram (post-review)

The original flow diagram above remains accurate at the stage level. This refined diagram folds in the design holes resolved in the table above — UPSERT dedupe, severity windows from a real ring buffer, persistent rate-limit storage, polling revert detection, brain budget gate, and the kill-switches.

```
┌──────────────────────────────────────────────────────────────────────┐
│                          1. CAPTURE                                  │
│                                                                      │
│   Bridge:   process.on('uncaughtException' | 'unhandledRejection')   │
│   Agents:   withAgentTick catch-arm — POST /api/bugs/report          │
│             (alongside existing flaky→degraded escalation)           │
│   Web UI:   <ErrorBoundary>.componentDidCatch — POST report          │
│             window.onerror + unhandledrejection in main.tsx          │
│   Note:     dev/preview builds only in Phase A (Vite minify          │
│             collapses fingerprints — Phase B adds source-map         │
│             resolution at capture time)                              │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          2. DEDUPE                                   │
│                                                                      │
│   fingerprint = sha256(source + errorName + normalizedMessage        │
│                        + topFrame-skip-wrappers)                     │
│                                                                      │
│   Single statement (no SELECT-then-INSERT race):                     │
│     INSERT INTO bugs (fingerprint, source, ..., last_seen_at)        │
│       VALUES (?,?,?,...,now())                                       │
│       ON CONFLICT(fingerprint) DO UPDATE SET                         │
│         occurrence_count = occurrence_count + 1,                     │
│         last_seen_at     = excluded.last_seen_at;                    │
│                                                                      │
│   Always append to bug_occurrences(bug_id, seen_at) — ring buffer    │
│   feeds severity windows ("≥10 in 1h", "≥5 in 24h") from real        │
│   data, not from the collapsed occurrence_count.                     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ (only newly-inserted rows continue)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       3. INVESTIGATE                                 │
│                                                                      │
│   BugInvestigatorAgent (always-on). Polls:                           │
│     SELECT * FROM bugs                                               │
│      WHERE status='new'                                              │
│        AND source != 'bug-investigator'   ← recursion guard          │
│        AND investigation_attempts < 3     ← bounded retries          │
│                                                                      │
│   Pre-flight gates (any failure → skip, surface in /bugs):           │
│     • BUG_INVESTIGATOR_ENABLED=1  (kill-switch, default 1)           │
│     • brain.budget.checkAndCharge('bug-investigator', user='maaz')   │
│     • BUG_INVESTIGATOR_MAX_PER_HOUR not exceeded                     │
│                                                                      │
│   Evidence:                                                          │
│     • stack + file:line                                              │
│     • git log --since=<bug.first_seen_at − 24h>                      │
│     • code-graph blast radius (via fixed query — ADR-027 v2)         │
│     • brain recall: similar past bugs in bug_investigations          │
│                                                                      │
│   Brain.get_decision(...) → root_cause, files_to_change,             │
│                              confidence, suggested_patch             │
│                                                                      │
│   Record: bug_investigations(bug_id, ..., decided_at,                │
│                              brain_decision_id);                     │
│           bugs.investigation_attempts += 1                           │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     4. PROPOSE / ALERT                               │
│                                                                      │
│   Materialize patch on side branch auto/bug-<id>-<fp:8>              │
│   Run: git apply --check, npm run typecheck, npm run smoke:*         │
│                                                                      │
│   AUTO-MERGE GATE (Phase D — all must hold):                         │
│     • BUG_AUTO_MERGE=1                       ← kill-switch           │
│     • bug.source ∈ {bridge, agent, web-ui, sync}                     │
│     • files ⊆ src/** | web/src/**                                    │
│       AND ∉ {schema, migrations, web-server.js boot, package.json,   │
│              lockfiles, .env*, .claude/**, tsconfig*, vite.config,   │
│              vitest.config, .env.example, scripts/smoke-*.sh}        │
│     • severity ∈ {low, medium}                                       │
│     • confidence ≥ 0.9, files ≤ 2, lines ≤ 20                        │
│     • smoke + typecheck PASS                                         │
│     • merge target ≠ main / master                                   │
│     • rate-limit OK (queries auto_merge_audit, persistent)           │
│     • cooldown not active (auto_merge_blocklist + last 24h reverts)  │
│                                                                      │
│   ┌──────────┴──────────┐                                            │
│   │ all pass            │ any fail                                   │
│   ▼                     ▼                                            │
│   merge to side branch  POST /api/pr/create { dry_run: true }        │
│   commit prefix:        → draft PR for Maaz                          │
│     'auto-fix:'         + surface in /bugs page                      │
│   trailer:              + Atlas alert feed                           │
│     Auto-Merged-By: …   + homepage banner if severity=high           │
│   write auto_merge_audit row (powers the rate limiter)               │
│                                                                      │
│   Path-to-master (open question — pick at Phase D planning):         │
│     (a) collect into long-lived 'auto-fixes' branch +                │
│         weekly batch PR to master                                    │
│     (b) auto-open dry-run PR from side branch into master            │
│         (RECOMMENDED — honors hard rule literally)                   │
│     (c) drop auto-merge entirely; Phase D becomes auto-PR-only       │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  REVERT-DETECTION RECONCILER                         │
│                                                                      │
│   Polling (primary, default — WI is a local clone, not git server):  │
│     every 60s, run: git log --grep='^auto-fix:' main..HEAD           │
│     for each commit C in auto_merge_audit:                           │
│       if C reverted (look for matching 'Revert "auto-fix:'):         │
│         INSERT INTO auto_merge_blocklist(fingerprint, reason='revert')│
│         disable BUG_AUTO_MERGE for 24h (cooldown row in same table)  │
│                                                                      │
│   Hook (optional, future extension):                                 │
│     post-receive on the bare git remote, if one ever exists.         │
│     Listed as Future Extension in ADR.                               │
└──────────────────────────────────────────────────────────────────────┘
```

This refinement does not change the four stages — it makes the previously hand-waved guardrails (severity windows, rate limit, revert detection, brain budget, kill-switches) concrete enough to implement. The original flow diagram stays as the at-a-glance view; this one is the implementation reference.
