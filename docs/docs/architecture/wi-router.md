---
sidebar_label: "/wi Skill Router"
sidebar_position: 33
---

# /wi Skill Router — Architecture View

> **Status:** Proposed (v1 design). The formal decision lives in [ADR-033](../adr/adr-033-wi-router). This page is the architecture-flavoured view: how /wi router fits into the existing WI brain + skill substrate.
> **Date:** 2026-06-07

---

## Why this exists

WI ships **36 `wi-*` skills** today. The user's Claude Code prompt has slash-command tab-completion, but only after the user types enough characters to disambiguate — which assumes the user *remembers the skill name in the first place*. The long tail (`wi-blast-radius`, `wi-frontmatter`, `wi-check-links`, `wi-correlate`, `wi-teammate`, `wi-action-items`, `wi-ticket-links`, `wi-find-expert`) is forgotten between uses; the user falls back to whichever 5–6 skills muscle-memory remembers and the rest rust unused.

The fix the user actually asked for is **natural language dispatch**: type `/wi <plain English>` and let the system pick the best skill. But the daily-fired skills (`/wi-investigate`, `/wi-update-context`, `/wi-search-all`) must **not** get slower — they're the workhorses, and the user explicitly forbade adding latency to them.

That constraint pair — *NL dispatch for the long tail without slowing the head* — is what `/wi` exists to solve. Slash commands stay fastest for known skills (zero-latency, zero-LLM); `/wi` is the abstraction tax the user only pays when:

- the request is **ambiguous** ("figure out why PROJ-15702 is flaky")
- the right skill is **forgotten** ("the one that maps a Jira to a PR")
- the request **spans multiple skills** ("investigate then save findings")
- the user is **off-Claude-Code** (Atlas, n8n, mobile) and slash commands aren't available

For everything else, slash commands win. `/wi` is the discovery layer, not the default surface.

---

## End-to-end flow

Three walkthroughs cover the v1 surface area.

### Happy path — read-category skill, high confidence

User types `/wi investigate PROJ-15702` in Claude Code.

1. `skills/wi-router/SKILL.md` runs. Its body is Bash-only (`allowed-tools: [Bash, Read]`); it does not call Anthropic from inside the skill. It curls `POST http://localhost:3132/api/router/route` with `{request, user, cwd, recent_files}`.
2. The bridge handler in `web-server.js` validates the body, builds the **skill catalog** (36 entries — name + 1-line description + WRITE/READ flag) from `TOOL_MANIFEST` + on-disk `skills/wi-*/SKILL.md` frontmatter, then calls `runDecision({question, decision_kind: 'skill_route', tools: <catalog>, params: bucketCallParams(db, 'decide')})`.
3. The brain runs over the 36-tool manifest, the cache is keyed by `decision_kind='skill_route'` + normalized request hash + user, and (cold path) Opus 4.8 emits a `tool_use` block selecting `wi-investigate` with high confidence. Recall surfaces 3 prior investigations of PROJ-15702 as evidence.
4. The handler `INSERT INTO router_decisions` (outcome=`pending`) and returns `{chosen_skill: 'wi-investigate', confidence: 0.87, rationale, evidence: [...3], alternatives: [...2], requires_confirmation: false, suggested_command: '/wi-investigate PROJ-15702', cached: false}`.
5. SKILL.md renders the decision card in chat:
   ```
   → wi-investigate (87%) — PROJ-15702 is a Jira key; investigate is the canonical 3-layer ReAct tool.
   Evidence: 3 prior investigations cited
   Alternatives: 1) wi-bug-report (62%) 2) wi-jira-analyze (54%)
   Run /wi-investigate PROJ-15702? [Y / 1 / 2 / n]
   ```
6. User types `Y`. SKILL.md prints `/wi-investigate PROJ-15702` as the exact next command and **stops**.
7. The user themselves fires `/wi-investigate PROJ-15702`. The router does not invoke another skill — that's the v1 invariant.
8. (Best-effort) the SKILL.md confirm path POSTs `/api/router/outcome {decision_id, outcome: 'ran'}` so the row's outcome flips off `pending`.

### Write-skill blocked path — confirmation required

User types `/wi sync wi context for this session`.

1. Catalog generation tags `wi-update-context` as `write_category: true` at catalog-build time (server-side, hard rule — see [Catalog generation](#catalog-generation) below).
2. The route handler runs the brain, gets back `chosen_skill: 'wi-update-context'`, and **forces** `requires_confirmation: true` regardless of what the brain emitted. This gate is in `src/services/router/route.ts`, not in the brain — write-category skills cannot opt out.
3. SKILL.md prepends a yellow banner: `⚠ Write-category skill — will modify state. Re-confirm before running.`
4. The user must explicitly type the suggested command (`/wi-update-context`) themselves. The router NEVER auto-fires write-category skills, even on `Y`.

This mirrors the existing WI invariants for stateful operations: `BUG_AUTO_MERGE=0` default, `BUG_RESOLVER_ENABLED=0` default. The router's user-confirms baseline is what unlocks any future v2 auto-confirm threshold for read-only skills.

### Low-confidence path — clarifying lead

User types `/wi check`.

1. The brain returns `chosen_skill: 'wi-health'` with `confidence: 0.31` and `alternatives: [{wi-bug-resolve, 0.28}, {wi-correlate, 0.25}]`.
2. SKILL.md detects `confidence < 0.4` (configured threshold; 0.5 in the docs prose, 0.4 in the SKILL.md `<rules>` block — the SKILL.md threshold wins) and prepends:
   `Low confidence — pick from alternatives or rephrase.`
3. v1 stops here. The card still renders so the user can pick `1` or `2` if they recognise the right skill, but the lead text tells them rephrasing is usually better.
4. **v2 plans** to escalate sub-0.5 routes to a clarifying-question subagent (AskUserQuestion-style: "Did you mean: the system health check, or a Jira blast-radius check?") — deferred until the eval set has enough sub-0.5 examples to make the question template tractable.

### Architecture diagram

```
User
  │  /wi figure out why PROJ-15702 is flaky
  ▼
┌─────────────────────────────────────────────┐
│ Claude Code skill runtime                   │
│ skills/wi-router/SKILL.md                   │
│  • allowed-tools: Bash, Read                │
│  • body: curl POST /api/router/route        │
│  • renders decision card                    │
│  • prints exact /wi-<chosen> command        │
└──────────────────┬──────────────────────────┘
                   │  HTTP POST /api/router/route
                   ▼
┌─────────────────────────────────────────────┐
│ web-server.js                               │
│  POST /api/router/route                     │
│   1. validate body (zod)                    │
│   2. build skill catalog (TOOL_MANIFEST +   │
│      skills/wi-*/SKILL.md frontmatter)      │
│   3. classify WRITE vs READ skills          │
│   4. call runDecision({                     │
│        question, decision_kind:'skill_route'│
│        tools: <36 skill catalog>,           │
│        params: bucketCallParams(db,'decide')│
│      })                                     │
│   5. INSERT INTO router_decisions           │
│   6. return {skill,confidence,evidence,...} │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ src/services/brain/decision-engine.ts       │
│  runDecision()                              │
│   • cache lookup (decision_kind in key)     │
│   • recall.ts → top-3 palace/claude-mem     │
│   • Anthropic Opus 4.8 / max with tools     │
│   • interleaved thinking; tool_choice auto  │
│   • returns DecisionResult                  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
        Anthropic Messages API (Opus 4.8)
                   │
                   ▼ JSON back up the stack
User reads decision card  →  types /wi-investigate PROJ-15702
                                       │
                                       ▼  (real skill runs)
                            existing /wi-* skill flow
                                       │
                                       ▼
                  optional POST /api/router/outcome  (v1.1)
```

---

## Catalog generation

The 36-tool manifest the brain sees at request time is **generated**, not hand-maintained. It joins two sources:

- **`src/tools/manifest.ts`** — `TOOL_MANIFEST`, the canonical source of skill names. Already drives MCP registration (`src/server.ts`) and Atlas plugin (`src/openclaw/plugin/src/wi-tools.ts`) per ADR-025.
- **`skills/wi-*/SKILL.md` frontmatter** — each skill's `name`, `description`, and `argument-hint` fields. The frontmatter `description` is the **canonical routing string** — it's what the brain reads when picking, so descriptions are tuned for routing legibility (1 line, role-tagged, intent-rich).

`src/services/router/skill-catalog.ts` walks both sources, joins by skill name, and emits Anthropic-tool-shaped JSON: `{name, description, input_schema, write_category}`. Cached in-process for 60s so repeated requests within a session don't re-walk disk.

### Categories

Each skill is tagged into one of four categories at catalog-generation time (server-side, hard rule):

| Category | Examples | `write_category` flag |
|---|---|---|
| **investigative** | `wi-investigate`, `wi-jira-analyze`, `wi-correlate`, `wi-pr-review`, `wi-blast-radius` | false |
| **retrieval** | `wi-search-all`, `wi-teams-search`, `wi-palace-query`, `wi-action-items`, `wi-teammate`, `wi-find-expert`, `wi-ticket-links` | false |
| **action-write** | `wi-update-context`, `wi-bug-resolve`, `wi-bug-resolve-all`, `wi-save-to-ticket`, `wi-sync` | **true** |
| **meta** | `wi-health`, `wi-add-bucket`, `wi-bug-report`, `wi-frontmatter`, `wi-check-links` | false |

Action-write skills get `requires_confirmation: true` baked into the catalog **at generation time** — this is a server-side hard rule, not a runtime branch. A future code edit cannot accidentally let the brain return `requires_confirmation: false` for `wi-update-context`, because the route handler always overlays the catalog flag onto the brain output:

```ts
// pseudocode in src/services/router/route.ts
const catalogEntry = catalog.find(c => c.name === brainPick.skill);
const requires_confirmation = catalogEntry.write_category || brainPick.requires_confirmation;
```

### Deprecated stubs

Five skills are deprecated stubs (their SKILL.md leads with `[DEPRECATED — use wi-X]`):

- `wi-blast-radius` → use `wi-code-impact`
- `wi-who-owns` → use `wi-code-impact`
- `wi-frontmatter` → use `wi-memory-audit`
- `wi-check-links` → use `wi-memory-audit`
- `wi-daily-digest` → use `wi-ask-topic`

These get a hardcoded **Beta(1, 10) prior** in the catalog so the brain still sees them (they're real skills the user can still run), but disprefers them. v2's `skill_priors` table will replace this hardcode with a learned prior; v1 ships the static dispreference so the router doesn't surface deprecated names to a user who didn't ask for them by name.

### Boot-time validation

If disk has a `wi-*` directory missing from `TOOL_MANIFEST` (or vice versa), the catalog builder emits a warning to stderr at boot:

```
[router] catalog drift: wi-foo present on disk but missing from TOOL_MANIFEST
[router] catalog drift: wi-bar in TOOL_MANIFEST but no skills/wi-bar/ on disk
```

The router still boots — the catalog excludes the drifted entry — but the warning is the canary that someone added a skill without updating the manifest (or vice versa). Smoke § 17.1 catches this on every bridge restart.

---

## Brain dispatch

`/api/router/route` reuses the existing brain decision engine. No new agent class, no new model bucket, no fork of the manifest.

### Bucket reuse

The router calls `bucketCallParams(db, 'decide')` — the same bucket the existing `/api/brain/decide` endpoint uses. There is **no 9th bucket**. The 8 buckets stay (fetch, digest, chat, analyse, **decide**, agents, bug-investigator, bug-resolver); the router slots into `decide` because routing-with-evidence is structurally a decision problem, and the bucket is already tuned for it.

The smoke § 15 bucket-count assertion still expects 8 — no migration to that test.

### Cache namespace

The brain decision cache is keyed by `(question, user, UTC day)` for fact decisions (TTL 24h). The router cannot share that key namespace — `"investigate PROJ-15702"` is a routing question, not a fact question, and a cache hit must not return a stale skill name to a `decide-stream` caller (or vice versa).

The fix is a **mandatory namespacing parameter** in the cache key: `decision_kind`. The router calls `runDecision({..., decision_kind: 'skill_route'})`; the brain's `cacheKey()` includes `decision_kind` in its inputs. Two different `decision_kind`s with the same question hash to different rows. A unit test in `tests/services/router/route.test.ts` asserts this — the regression risk is high enough that the test is non-optional.

The router's TTL is **1 hour**, not 24h. Routing is wording-sensitive: `"investigate PROJ-15702"` and `"look into PROJ-15702"` should arguably both pick `wi-investigate`, but a shorter TTL means a poorly-routed first call doesn't pin the answer for the rest of the day. v2's clustering step closes the rephrasing gap; v1 accepts the cache miss on minor rephrasings as a known limitation.

### Per-user per-hour cap

`src/services/brain/budget.ts` already enforces a per-bucket budget. The router adds a **60-call/user/hour cap** on top — independent of the underlying bucket budget, so a runaway router loop can't drain the broader Opus credits the rest of the system depends on. Smoke § 17.6 fires 61 requests in &lt;60 s and asserts the 61st returns `code='budget_exceeded'`.

### Tool-list size constraint

36 tools is past the comfort zone for Haiku context. If someone flips the `decide` bucket to Haiku in `/setup/models`, the router degrades silently — Haiku will pick *a* tool, but the picks become noticeably worse on the long tail.

The mitigation is an **assertion at request time** in the route handler:

```ts
const params = bucketCallParams(db, 'decide');
if (!params.model.includes('opus')) {
  return { ok: false, error: { code: 'wrong_model_bucket', message: 'router requires opus-tier; current decide bucket is ' + params.model } };
}
```

Documented in `.claude/rules/model-config.md` (todo): the router pins to `decide`, and the `decide` bucket must stay Opus-tier. If the user wants to demote `decide`, they need to provision a 9th bucket first — that's a deliberate friction point.

---

## Schema additions (v57)

`CURRENT_SCHEMA_VERSION` bumps **56 → 57**. The migration runs in the same in-file pattern as v52–v56 (inline in `src/db/schema.ts`, serialized via `BEGIN IMMEDIATE` so concurrent bridge starts don't race).

```sql
CREATE TABLE IF NOT EXISTS router_decisions (
  id TEXT PRIMARY KEY,                    -- decision_id, ULID-ish (reuses decision-engine.ts decId())
  request TEXT NOT NULL,                  -- raw user input as typed
  normalized_request TEXT NOT NULL,       -- lowercase + collapsed whitespace, sha256-ed for cache key
  user TEXT NOT NULL DEFAULT 'maaz',
  decided_at INTEGER NOT NULL,            -- unix ms
  chosen_skill TEXT NOT NULL,             -- e.g. 'wi-investigate' (validated against the catalog)
  confidence REAL NOT NULL,               -- 0.0..1.0
  rationale TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',    -- JSON array of RouterEvidence
  alternatives TEXT NOT NULL DEFAULT '[]',-- JSON array of RouterAlternative (length <= 2)
  requires_confirmation INTEGER NOT NULL DEFAULT 0,  -- 0/1; ALWAYS 1 for write-category skills
  suggested_command TEXT NOT NULL,
  cached INTEGER NOT NULL DEFAULT 0,      -- whether this row hit the warm cache
  outcome TEXT NOT NULL DEFAULT 'pending',-- 'pending'|'ran'|'rejected'|'alternative_picked'|'failed'
  outcome_alternative_index INTEGER,      -- 0|1|NULL
  outcome_note TEXT,
  confirmed_at INTEGER,                   -- unix ms when outcome was POSTed
  CHECK (outcome IN ('pending','ran','rejected','alternative_picked','failed'))
);

CREATE INDEX IF NOT EXISTS idx_router_decisions_user_decided
  ON router_decisions(user, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_router_decisions_chosen_skill_outcome
  ON router_decisions(chosen_skill, outcome);
CREATE INDEX IF NOT EXISTS idx_router_decisions_normalized
  ON router_decisions(normalized_request, user);

-- v57 bump in src/db/schema.ts CURRENT_SCHEMA_VERSION; migration runs in the same in-file pattern as v52–v56.
-- No new model_config row (router uses the existing 'decide' bucket). No bucket count change → smoke § 15 still expects 8.
```

**Forward-compat note:** v2 will add a `skill_priors` table aggregating `(user, skill, intent_cluster)` Beta(α, β) success rates. v1's `router_decisions.outcome` column is the source data for that aggregation — every v1 row is a v2 training point. No v2 schema change requires backfill: `outcome` is already populated by the SKILL.md confirm path.

---

## Confirmation UX

The decision card is the v1 surface. Its anatomy:

```
→ wi-investigate (87%)
PROJ-15702 is a Jira key; investigate is the canonical 3-layer ReAct tool.

Evidence:
• [palace] Prior investigation PROJ-15702 (2026-06-02) — score 0.91
• [claude-mem] PROJ-15702 PR #4055 token-cache fix — score 0.78
• [jira] PROJ-15702 — search-provider proxy 401 / infinite loop — score 0.74

Alternatives:
1. wi-bug-report (62%) — capture as a new bug if not yet tracked
2. wi-jira-analyze (54%) — broader 5-parallel AI pipeline

Run /wi-investigate PROJ-15702? [Y / 1 / 2 / n]
```

### Y/N/digit semantics

- **`Y` / `yes` / empty / Enter** → SKILL.md prints the exact `suggested_command` (e.g. `/wi-investigate PROJ-15702`) and stops. The user types it themselves.
- **`1`** → SKILL.md prints `alternatives[0].skill` with the original args. Stop.
- **`2`** → same, with `alternatives[1].skill`. Stop.
- **`n` / `no` / `cancel`** → SKILL.md prints `Cancelled. Try /wi <rephrased>.` and stops.

### SKILL.md outline

```yaml
---
name: wi-router
description: "Natural-language dispatcher for the /wi skill family. Type your intent in plain English; the router proposes the best /wi-<name> skill with confidence + alternatives, you confirm, you run it. Never auto-executes — especially for write-category skills (wi-update-context, wi-bug-resolve, wi-bug-resolve-all, wi-save-to-ticket, wi-sync)."
argument-hint: "<natural-language request>"
allowed-tools:
  - Bash
  - Read
---
```

The `<process>` block in SKILL.md walks: validate args → curl bridge → render card → read user reply → print suggested_command → STOP. The `<rules>` block enforces:

- The router never auto-runs a skill in v1.
- Write-category skills always get the yellow banner.
- If the bridge is unreachable (port 3132), print `Bridge offline — start it with npm run web:bridge` and stop. **Do not** fall back to a local Anthropic call. (The local-Anthropic fallback would let the router silently work without budget enforcement and without the per-hour cap — that's a regression vector worth blocking explicitly.)
- If `confidence < 0.4`, lead with the low-confidence banner.

### Why user-typed, not auto-fired

Write-class skills route through user-typed `/wi-<name>` rather than the router auto-firing them. This mirrors the established WI invariants:

- `BUG_AUTO_MERGE=0` default — auto-merge is opt-in even in Phase 76 of ADR-030.
- `BUG_RESOLVER_ENABLED=0` default — the resolver doesn't even register without explicit opt-in.

The router's user-confirms baseline is what makes any future v2 auto-confirm threshold even *thinkable*. If v1 shipped silent auto-fire on write skills, the system would never earn the trust it needs to graduate any subset of routing to auto-confirm in v2.

---

## v2 path (the actual learning loop)

v1 collects training data (`router_decisions.outcome`) but does not yet learn from it. v2 closes that loop. From `payload.design.deferred_to_v2`:

- **`skill_priors` table** — Beta(α, β) per `(user, skill, intent-cluster)`. Updated by `/api/router/outcome` POSTs. Reads back into the brain's decision context as evidence.
- **`recall.ts` read-back** — routing decisions surface "you've picked `wi-investigate` 8/10 times for this intent class" as an evidence row. Hooks into `augmentMemoryRelevant`. The user sees a prior-weighted recommendation, not a per-call cold pick.
- **Top-3 confirmed-without-edit demonstrations** — injected as `cache_control` few-shot exemplars into the routing system prompt. Costs ~2-4k cached input tokens, gained accuracy on rephrasings.
- **Auto-confirm threshold for read-only skills** — if `confidence >= 0.95` AND skill is read-category AND user has confirmed this exact normalized intent ≥ 3 times historically, skip the `[Y/n]` prompt. Strictly opt-in via a per-user setting. **NEVER for write skills** — the BUG_AUTO_MERGE invariant holds.
- **Two-skill chains** — `/wi investigate PROJ-15702 then save findings` proposes `wi-investigate` followed by `wi-save-to-ticket`. Cap: 2 skills. Three-skill chains break at solo-dev scale (per the published agent record on chain depth).
- **`GET /api/router/explain?decision_id=...`** — returns the full Anthropic message trace + tool_use input for debugging a misroute. v1 only stores the chosen tool, not the trace; v2 widens the row.
- **OPRO integration on skill descriptions** — the description strings in `TOOL_MANIFEST` and SKILL.md frontmatter are the routing levers. OPRO (per ADR-020 / wi-code-research engine pattern) optimizes them weekly against the live eval set. Deferred until eval set is ≥ 100 intents.

---

## Operational characteristics

### Latency budget

Cold path (cache miss):

| Stage | Estimate |
|---|---|
| DB lookup + catalog build (cached 60s in-process) | ~10 ms |
| Brain `runDecision()` Opus call | 3–6 s |
| JSON parse + `INSERT INTO router_decisions` | ~10 ms |
| HTTP round-trip (loopback) | ~5 ms |
| **Total cold** | **~3–6 s** |

Warm path (cache hit, same `decision_kind` + normalized request + user within TTL):

| Stage | Estimate |
|---|---|
| DB lookup + cache hit detection | ~10 ms |
| Cache row hydration | ~5 ms |
| `INSERT INTO router_decisions` (cached=1) | ~10 ms |
| HTTP round-trip | ~5 ms |
| **Total warm** | **&lt;500 ms** |

Smoke § 17.3 enforces the warm path: same request POSTed twice → second call wall-clock &lt; 1.5 s, `cached: true`.

### Token budget



### Failure-mode dictionary

| Symptom in smoke output | Likely cause | First action |
|---|---|---|
| Bridge returns `code='unknown_skill'` | Brain hallucinated a skill not in catalog | Catalog out of sync — re-run `scripts/install-skills.sh`; check `git status skills/` |
| All routes hit `requires_confirmation: true` | Catalog incorrectly tagged all skills as write-category | Inspect `src/services/router/skill-catalog.ts` categorization; check the `WRITE_CATEGORY_NAMES` set |
| `code='budget_exceeded'` | Per-hour cap tripped (60 calls in `<1h` for this user) | Wait, or reset via `DELETE FROM brain_budget WHERE bucket='decide' AND user='<user>'` |
| Cache HIT returns wrong skill | `decision_kind` not in cache key (regression) | Audit `decision-engine.ts` `cacheKey()` inputs; the route.test.ts cache-namespace assertion should have caught this |
| Schema migration race | Two bridges starting concurrently (e.g. dev + smoke killswitch child on :3133) | Reuses `BEGIN IMMEDIATE` — no action needed; if it persists, a third bridge is in flight |
| `code='wrong_model_bucket'` | Someone flipped the `decide` bucket to a non-Opus model | Restore `decide` bucket to opus-tier in `/setup/models`; document if a 9th bucket is genuinely needed |
| Catalog drift warnings at boot | A `wi-*` skill exists on disk but not in TOOL_MANIFEST (or vice versa) | Add the missing entry to `src/tools/manifest.ts`; re-run `install-skills.sh` if a symlink is missing |

---

## Smoke § 17 spec

Six new cases land in `scripts/smoke-bridge.sh` § 17. Total smoke count moves from 65/65 to 71/71.

- **§ 17.1 — Catalog freshness.** `POST /api/router/route` with `request: '__debug_catalog__'` returns `data.catalog_size` matching `ls skills/ | grep -c '^wi-'`. Asserts catalog isn't stale vs disk.
- **§ 17.2 — Read routing happy path.** `request: 'investigate PROJ-15702 root cause'` returns `chosen_skill === 'wi-investigate'` AND `requires_confirmation === false` AND `evidence.length >= 1`.
- **§ 17.3 — Cache warm path.** Same request POSTed twice; second call returns `cached: true` and total wall-clock &lt; 1.5 s.
- **§ 17.4 — Write-category gate.** `request: 'sync wi context for this session'` returns `chosen_skill === 'wi-update-context'` AND `requires_confirmation === true` AND the response contains `'Write-category'` in `rationale` OR a `safety_note` field.
- **§ 17.5 — Unknown-skill defense.** Stub the brain (env `WI_ROUTER_FORCE_TOOL=wi-not-real-skill`) and assert the route handler falls back to `alternatives[0]` instead of returning the bogus name. Exit non-zero if `chosen_skill === 'wi-not-real-skill'`.
- **§ 17.6 — Per-hour cap.** Hammer the endpoint 61× with a unique-request-each-time loop; assert request 61 returns `ok: false` with `code='budget_exceeded'`. Then `DELETE FROM brain_budget WHERE bucket='decide'` (or equivalent reset) so subsequent smoke runs aren't blocked.

---

## Docusaurus integration

- **Doc file:** `docs/docs/architecture/wi-router.md` (this file)
- **Sidebar position:** under the "Architecture" group, immediately after `'architecture/persona-memory-loop'`. Exact entry: `'architecture/wi-router'`.
- **Cross-links:**
  - [ADR-033 — `/wi` Skill Router](../adr/adr-033-wi-router) (the formal decision)
  - [ADR-024 — Unified Brain](../adr/adr-024-unified-brain.md) (the brain pillars the router reuses)
  - [ADR-031 — Per-bucket model+effort config](../adr/adr-031-per-bucket-model-effort-config.md) (the `decide` bucket the router pins to)
  - [Architecture — MemPalace Second Brain](./mempalace-second-brain.md) (recall hits surfaced as evidence)
  - [Architecture — Second-brain Recall](./second-brain-recall.md) (the recall fan-out feeding evidence ranking)
  - [Architecture — Research Engine](./research-engine.md) (OPRO pattern reused in v2 for description optimization)

A user-facing skill page also lands at `docs/docs/skills/wi-router.md` per the Docusaurus convention; this architecture page is the engineering companion.

---

## Open questions / future work

These are deliberately deferred from v1 — listed so they don't get lost.

- **Should v2 expose router as a `wi_route` MCP tool for Atlas plugin parity?** Adding it to `TOOL_MANIFEST` is trivial once v1 stabilizes. The argument *for*: Atlas / OpenClaw / future MCP hosts get NL dispatch for free, no per-host re-implementation. The argument *against*: MCP tool calls compose worse than slash commands in Claude Code (two-step UX vs one-shot). Resolution: ship in v2 only if Atlas usage exceeds Claude Code usage.
- **Should the eval set live in `.planning/phases/` or in `tests/services/router/eval-30.test.ts` as embedded data?** Current proposal puts the JSONL under `.planning/phases/77-wi-skills-overhaul/wi-router-30-intent-eval.jsonl` (it's evaluation harness data, not user-facing). The vitest harness reads the JSONL. The trade-off: planning-tree placement keeps test data out of `tests/`; embedded placement keeps the test self-contained. Decide before merge.
- **Should low-confidence (&lt;0.5) routes auto-escalate to a clarifying-question subagent in v2?** AskUserQuestion-style: "Did you mean: the system health check, or a Jira blast-radius check?" Requires a question-template generator the v1 brain doesn't have. Tractable once the eval set has enough sub-0.5 examples to train the template; deferred until then.
