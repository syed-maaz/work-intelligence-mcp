---
sidebar_label: "ADR-036: Cypher CLI as primary surface"
sidebar_position: 36
title: "ADR-036: Cypher CLI as Primary Surface — Bridge Is the Brain, CLI Is the Rich Channel"
status: Proposed (2026-06-15)
date: 2026-06-15
---

# ADR-036: Cypher CLI as Primary Surface — Bridge Is the Brain, CLI Is the Rich Channel

**Status:** Proposed (2026-06-15). Promoted from Draft after BRAINSTORM walkthrough completed all 8 questions.

**Cypher session:** `cyp_0e54f996000d`
**BRAINSTORM bookmark:** [`.planning/phases/86-cypher-cli-primary/BRAINSTORM.md`](../../../.planning/phases/86-cypher-cli-primary/BRAINSTORM.md)
**Related:** [ADR-024](./adr-024-unified-brain.md) (Unified Brain pillar), [ADR-033](./adr-033-cypher-framework.md) (Cypher framework — depth-≤2 invariant superseded for `auto`-class only by this ADR), [ADR-034](./adr-034-cypher-learning-autonomy-engine.md) (learning engine), [ADR-035](./adr-035-chat-brain-unification.md) (chat brain unification — parked).

---

## Context

Cypher exists today behind an HTTP endpoint (`POST /api/wi/dispatch`). The `/wi` slash command is a thin bash wrapper that POSTs the goal to the bridge over localhost HTTP, parses the JSON response with python3, prints a decision card, and stops — asking the user to type the next slash command themselves (the "depth ≤ 2 invariant" from ADR-033).

This shape was correct when `/wi` was conceived as a **router** — a tool that helps the user pick which `/wi-X` skill to run. It's wrong now that the user wants Cypher to be a **mind** — something they talk to, that decides what to do, and acts on it.

Three problems with the current shape:

1. **Cold-call latency on every dispatch** — every call round-trips localhost HTTP (~50–200ms) AND the bridge cold-loads catalog, priors, and saved context fresh each time. There's no warmth between calls.
2. **Conversational context is thrown away** — the bridge only sees what's persisted to disk (DB, palace). It can't see recent edits, the active task list, what the user and assistant have been discussing for the last hour. That context is the most valuable signal Cypher could have, and we're discarding it on every call.
3. **Two-step interaction friction** — Cypher picks a skill, prints a card, and the user has to copy/paste / type the next command. For skills that don't affect colleagues or critical machine state, Cypher should just invoke them.

Meanwhile, **the user's stated priority is the CLI surface**. UI is parked (no preferred shape yet — see ADR-035). n8n / external automation is bookmarked, not driving design. So the architecture needs to optimize for `/wi` from inside Claude Code — and let HTTP keep working for the future-extensible cases without driving today's design.

## The principle

**One brain. Bridge is the brain's home. CLI is the user's rich channel into that brain.** Future surfaces (UI, n8n, MCP, Atlas) plug into the same brain via the same channel pattern.

The bridge is **infrastructure** — it fetches data from external sources (Jira, Teams, Outlook, GitHub, calendar, palace), processes and structures it in SQL, and hosts long-running agents (BugInvestigator, BugResolver, OrchestratorAgent, etc.). Cypher lives **inside** the bridge. It uses the bridge's full capabilities (palace recall, brain context, KG, model-config buckets, learning loop) instead of bypassing them.

The CLI is the user's primary surface today. What's wrong about today's CLI isn't that it talks to the bridge — it's that **CLI uses the bridge in a dumb way** (stateless cold POST per dispatch). The fix is to make CLI talk to Cypher via a **richer channel** (SSE streaming + 1h prompt cache + saved-context cold start) so the surface gets the full Cypher capability without the cold-call penalty.

> **Bridge is Cypher's body. Agents are Cypher's reflexes. CLI is the user's primary surface to Cypher today.** Repetitive work (catalog warmth, prior updates, palace breadcrumbs) lives inside the bridge as agents and SQL — not recomputed per call. Token cost is structurally minimized via deliberate prompt-cache design, not by avoiding the LLM.

## Decision

The BRAINSTORM walkthrough confirmed 14 sub-decisions. Each is captured below by section.

### D1 — Cypher lives in the bridge; CLI is a rich channel; v1 SSE streaming + 1h cache + saved-context cold start; v2 long-lived CypherAgent

The bridge stays the home of Cypher. CLI talks to it via a richer channel than today's stateless POST.

**v1 — richer channel + saved-context-warm starts:**

- New SSE endpoint `/api/wi/dispatch/stream` streams stages back as Cypher runs (clarify → research → plan → execute → surface). Same shape as the existing `/api/brain/decide/stream`. CLI sees Cypher think.
- Cold-start pulls saved context from the bridge's existing memory layers: `cypher_sessions` recent dispatches and outcomes, MemPalace semantic recall, `/api/brain/context` operational snapshot, claude-mem cross-session observations, `wi-update-context` saved breadcrumbs.
- Saved context becomes the cacheable prefix. Bridge packs (system prompt + skill catalog summary + priors snapshot + saved-context payload) into the LLM call with `cache_control: { type: 'ephemeral', ttl: '1h' }` (D1.4).
- Token savings within a working session: subsequent dispatches in the next hour hit the prompt cache for ~10% of normal token cost. First dispatch in an hour pays full cost (~2× cache-write premium). Net huge savings during a typical 1–2 hour focused session.
- Investigate stage stops being a stub — actually pulls relevant memories instead of returning the v1 stub message (D1.5).
- After dispatch, optional breadcrumb write back via MemoryEnricher so the next session's cold start has even more saved context to pull. The cycle compounds.

**v2 — long-lived CypherAgent inside the bridge:**

- Phase after v1 soaks. v1's prompt structure feeds directly into v2 — no throwaway work.
- `CypherAgent` runs continuously inside the bridge (like BugInvestigatorAgent, OrchestratorAgent). Holds catalog + priors + recent palace memories in-memory across calls.
- Compute savings on top of v1's token savings — no SQLite/palace re-fetch on every dispatch.
- Cross-session warmth without 1h cache TTL boundary — agent state survives across `/wi` invocations indefinitely (subject to memory bounds).
- Foundation for proactive Cypher behaviors (notice things between dispatches, surface unsolicited observations).

**Sub-decisions:**

- **D1.1** — Local-LLM routing in scope. Cypher can route to Ollama / Qwen / local models for classifier-shaped stages where Anthropic isn't needed. Implementation detail deferred to PLAN.md; principle locked.
- **D1.3** — Plan stage gets an Opus master-plan sub-step for `complexity=heavy` dispatches. Today the plan stage is pure deterministic ranking (Beta priors); v1 adds an Opus sub-call for heavy work that lays down dependencies and waves like a senior architect. Light dispatches stay deterministic.
- **D1.4** — Use Anthropic's 1-hour cache TTL (`ttl: '1h'`) on the cacheable prefix, NOT the 5-minute default. Matches typical working-session length. Verified against [Anthropic's prompt-caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching): syntax is `cache_control: { type: 'ephemeral', ttl: '1h' }`; cache-write cost is 2× base input token price (vs. 1.25× for the 5-min default); cache hits don't count against rate limits. Available on Claude API.
- **D1.5** — Cold-start saved-context pull from palace + brain + cypher_sessions + claude-mem feeds the cacheable prefix. The bridge's existing memory infrastructure becomes Cypher's persistent warmth layer; the 1h prompt cache is the per-session speedup on top.

**Deferred sub-decision:**

- **D1.2** — Model-per-stage mapping table (which Anthropic bucket / which model runs which Cypher stage) needs its own design conversation. Maaz pushed back on the assistant's proposed mapping during walkthrough; the right table is its own design discussion, picked up after PLAN.md outline is sketched (so stages and model needs are known concretely).

### D2 — Transport contract: hybrid SSE + outcome-rendering + faithfulness verification

#### D2.A — SSE event granularity: hybrid

- **Fine streaming** on stages with LLM output where the *thinking matters* (clarify, plan, summary). User sees Cypher reason word-by-word.
- **Coarse streaming** on deterministic stages (Beta-prior ranking, path-classifier rules, DB writes). One event per stage, with the structured output. No noise.

#### D2.B — Render contract: outcome-rendering, NOT progress-narration

The principle (Maaz's framing, sharper than the assistant's original "live narration" proposal): **show what's useful as context for the next decision; don't narrate the plumbing.**

| Stage situation | What CLI renders |
|---|---|
| Test running (quality_gate, in-progress) | Nothing. Render the pass/fail signal only when it lands. |
| Research mid-flight (scanning palace / brain / sessions) | Nothing. Suppress the searching activity. |
| Research complete | **Findings only**, in a form usable as context for next-stage prompts — not the raw search trace. |
| Clarify / plan with LLM thinking | **The thinking.** Fine-grained streaming, the user wants to see Cypher reason. |
| Execute (skill running via Skill tool) | The skill's own output speaks for itself. No "skill is running" narration. |
| Decisions (chosen skill, ambiguity verdict, complexity score) | The decision itself, structured. |
| Side-effect signals (smoke pass/fail, schema OK, write committed) | Only the signal. Not "I am writing… I am committing…" |

**Implementation note:** the bridge needs to declare per-stage what kind of output it produces — `thinking`, `findings`, `signal`, `decision`, `side-effect-only` — so the CLI renderer knows what to show vs suppress. This becomes a small per-stage metadata addition to `run.ts`.

#### D2.C — Faithfulness verification: both layers

- **Schema enforcement on the wire.** Every SSE event has a strict JSON schema. Malformed event = CLI fails loudly, never silently renders garbage.
- **Smoke verification.** New smoke section runs N test goals, captures the bridge's decision JSON + the CLI's rendered output, asserts they match. Drift = bug. Catches the case where schema is valid but rendering misrepresents.

The two layers compose: schema is the immediate guard on every call (fast feedback when formats drift); smoke is the periodic audit (catches semantic drift even when formats are valid).

### D3 — Extract-ask-execute loop ("find gold in shit")

**Cypher's job is to find gold in shit.** The user dumps imperfect, ambiguous, half-formed text — Cypher's job is to extract what's extractable, ask what's missing, and execute intelligently with its full toolbox. Maaz's framing dissolves the v1/v2 case-distinction the assistant initially proposed; the right shape is one uniform loop from day one.

**The mandatory contract for every dispatch:**

1. **Extract** — pull every signal the goal text contains. Regex for the deterministic patterns (Jira keys, PR refs, file paths, slash commands). Reasoning for semantic ones (intent verb, target, scope, urgency, mood).
2. **Identify gaps** — for each candidate skill in the ranked pool, enumerate what's required vs what's been extracted. Skills with un-fillable required args drop out of the candidate pool naturally.
3. **Ask what matters** — for gaps that materially change the outcome, ask one targeted question via the clarify mechanism. Don't interrogate. Only ask if the answer changes what Cypher does. Every question carries a sensible default.
4. **Execute intelligently** — once Cypher has the gold, route through the full toolbox: ranked skill (Beta priors + arg-availability), right model per stage (D1.2 deferred), local LLM where applicable (D1.1), parallel/composed skills when warranted, stream findings via D2.B contract.

This subsumes the original ambiguity classifier (`classifyClarity`), the missing-arg detector originally proposed, and the Case 1/2/3 case distinctions from the assistant's draft — all collapse into one loop. The contract shape is locked from day one; depth of each stage grows with capability without redesign.

### D4 — Override dissolved into clarify+plan; natural-language understanding is the plan stage's job

**Override is dissolved as a separate concept.** No post-invocation pause/confirm gate. Cypher's natural-language understanding does the work of getting the goal right *before* execution; the clarify stage (D3) catches ambiguity *before* invocation.

**Maaz's load-bearing example** that drove this lock:

> "check this BDS-xxxx and if the PR is merged update the ticket or review the PR"

This goal has structure no regex extracts: a target, a first action, a conditional, two branches, an implicit dependency chain. **Pattern matching breaks; only natural-language understanding handles it.**

**The behavior contract:**

| Goal shape | Cypher's response |
|---|---|
| **Atomic** ("investigate PROJ-15702") | Single skill via D3 loop. Auto-invoke `auto`-class without preamble (D6, D8). |
| **Compound** ("check BDS-xxxx and update ticket") | Plan stage decomposes into a step sequence. Each step runs through its own extract-ask-execute loop. `auto` steps auto-invoke; `confirm` steps confirm. |
| **Conditional** ("check BDS-xxxx and if PR merged update ticket else review PR") | Plan stage produces a conditional plan with explicit branches. Cypher executes step 1, evaluates the condition from step 1's result, picks the branch, continues. |

**Implication for `scoreComplexity`** (existing scorer at `src/services/cypher/complexity.ts`): heavy isn't "long goal" — heavy means the goal has natural-language structure requiring reasoning. New signals: conjunctions ("and then", "and if", "or"), multiple action verbs, conditional words ("if", "when", "unless"), multi-target references, sequence words ("first/then", "after that").

**Wrong picks** are corrected by the user's next message (D7 outcome capture); they're a model failure (better Opus reasoning, better complexity signals), NOT a UX failure to be solved with confirmation gates.

**Escape hatch:** `/wi --force-skill <name>` syntax bypasses ranking entirely. Useful for testing and power-user "I know what I want." Not the primary path. Stays optional in v1.

### D5 — Bridge unreachable: three layered principles

**(1) No information lost** — every dispatch writes its full state to `~/.work-intelligence-mcp/queue/cyp_pending_<id>.json` BEFORE risky operations. Persists across CLI/bridge/OS crash. Cleared only on successful completion. Queue file is source of truth for resume.

**(2) Try to bring the bridge back up — intelligently** — initial timeout 30s; adapts based on observed bridge restart behavior persisted to `bridge_restart_log.json`. Adaptive policy:

- ≥5 observations, recent healthy: use `max(10s, 3 × p95_healthy_ms)`, floor 10s, ceiling 60s
- Bridge `npm run web:bridge` exits non-zero in `<2s`: capture stderr, hard-fail immediately
- ≥3 crash-restart loops in 10min: stop auto-restart; surface "bridge keeps dying" warning
- Healthcheck OK but agents crashed: surface degraded state, don't pretend healthy
- Recent successful restart in same dispatch: skip further retries

**(3) Always transparent with the user** — every step surfaced (warning, save location, restart attempt, healthcheck progress, success or timeout, recovery instructions). No silent degradation, no hidden retries.

**Resume mechanism:**

- `/wi --resume <id>` — reads queue file, continues from last completed step. Plan state survives partial execution; conditional plans pick up where they left off.
- `/wi --pending` — lists pending sessions with age, goal, last-completed-step.
- `/wi` with no args reads the queue and resumes the most recent unfinished session (interactive: confirms with the user before resuming).

**What this explicitly does NOT do:**
- No SQL-only fallback mode — when bridge is down, Cypher waits for it back up. Preserves D1's "one brain" principle.
- No background daemon auto-resuming the queue. v2 if real use cases warrant it.
- No silent retry without surfacing.

**Configuration knobs:**
- `CYPHER_BRIDGE_RESTART_TIMEOUT_MS` (default 30000)
- `CYPHER_BRIDGE_RESTART_DISABLED=1` (opt out of auto-restart)
- Queue location is fixed at `~/.work-intelligence-mcp/queue/`

### D6 — No confidence threshold for auto-invoke

**No confidence threshold for auto-invoke.** Maaz's stated rule: "any skill which doesn't write on Jira / repo / 3rd party I am okay with that to be called." Categorization (D8) is the only gate; μ is irrelevant. Even μ=0.1 `auto`-class skills auto-invoke — failures feed the learning loop, no harm done.

### D7 — Outcome capture via natural conversation

**Cypher reads the user's next message to determine outcome. No explicit feedback slash commands** (rejected `/wi-good` / `/wi-bad`).

The single rule:

When a skill returns, Cypher writes `outcome=mixed` as a placeholder. **No Beta movement on `mixed`.** On the user's next message in the same session, Cypher reads the reaction:

| User's next message | Cypher's interpretation | Outcome action |
|---|---|---|
| Correction language ("no", "wrong", "actually", "that's not what I meant", "you should have", explicit re-dispatch) | Implicit failure | Flip `mixed → failed`. Re-dispatch with correction folded in. |
| Same-topic continuation, follow-up question, implicit positive ("good", "thanks", deeper question) | Implicit success | Flip `mixed → success` |
| Unrelated topic switch | No signal | Stays `mixed` (no Beta movement) |

**The Beta prior updates only on `success` or `failed`.** `mixed` is the no-signal state. The prior never moves on noise. **The existing single Beta loop does all the learning** — no new mechanism, no new tables, no calibration tracker, no second predictor.

**Trigger architecture (who runs the classifier and when):**

The bridge does not see the user's next message directly — that message goes from the user to Claude Code's surface (CLI), not over HTTP to the bridge. So the outcome classifier cannot run reactively from the bridge side. The right shape is **deferred-on-next-dispatch**:

1. Skill returns. CLI's SKILL.md immediately writes `outcome=mixed` to `cypher_sessions` (no Beta movement). The session row is now "pending classification."
2. The user's next message arrives in the conversation — possibly minutes later, possibly the very next turn.
3. The user types `/wi <next goal>` (or any `/wi-*` skill). The slash command, before opening its new session, checks `cypher_sessions` for a pending-classification row from this user. If one exists:
   a. SKILL.md sends the user's last message **and** the prior dispatch's output to a new bridge endpoint `POST /api/wi/dispatch/classify-prior` (Haiku, agents bucket).
   b. Bridge classifies as correction / continuation / unrelated and updates the prior session's outcome.
   c. Beta priors update synchronously via the existing `recordSkillOutcomes`.
4. The new dispatch then proceeds normally.

**If the user never dispatches again** (session ends, `/wi` not invoked for hours), the classification simply doesn't happen and the prior session stays `outcome=mixed`. That's the honest state — no signal extracted, no Beta movement. The pending classification expires after a configurable window (default 24h) so the queue doesn't grow unbounded.

**What this means in practice:**
- Outcome capture is **async-on-next-use**, not synchronous-on-completion.
- If the user dispatches `/wi` rapidly (within seconds), classifier sees a tight signal.
- If the user takes a break and forgets, no false signal.
- The classifier never blocks the new dispatch — it runs in parallel; if it's slow, the new dispatch starts anyway.

**Implementation:** Haiku classifier (agents bucket) reads the user's last message + the prior dispatch's output, classifies as correction / continuation / unrelated. Updates outcome accordingly. If correction, extracts the correction signal and re-dispatches. **One new bridge endpoint** (`POST /api/wi/dispatch/classify-prior`) is required; no new schema, no new commands.

### D8 — Two-tier categorization: `auto` / `confirm` / `cli`

**Maaz's rule, plainly stated:**

> Auto-invoke any skill that reads OR writes within the WI project itself. Confirm before invoking any skill that affects colleagues (Jira comments, PR pushes, Teams/email) or performs critical machine operations.

The boundary is **NOT read-vs-write.** It's **does this stay inside WI, or leak out to other people / critical machine state.**

**Category system collapses from 4-way (`read | write | cli | unknown`) to 3-way:**

#### `auto` — anything that reads OR writes WI-internal state

Cypher invokes via Skill tool without asking. Includes:

- **Pure reads:** `wi-search`, `wi-search-all`, `wi-teams-search`, `wi-jira-analyze`, `wi-investigate`, `wi-pr-review`, `wi-blast-radius`, `wi-find-expert`, `wi-code-research`, `wi-pre-meeting`, `wi-morning-brief`, `wi-action-items`, `wi-daily-digest`, `wi-weekly-report`, `wi-status`, `wi-palace-query`, `wi-correlate`, `wi-ticket-links`, `wi-who-owns`, `wi-teammate`, `wi-check-links`, `wi-frontmatter`, `wi-health`
- **WI-internal writes:** `wi-bug-report` (local `bugs` table), `wi-update-context` (palace + claude-mem + auto-memory + cypher_sessions), `wi-record-outcome` (cypher_sessions), `wi-bug-resolve` / `wi-bug-resolve-all` (commits to WI repo, never pushes), `wi-add-bucket` (model_config), `wi-skill-install` (WI symlinks + install script), `wi-remind` (local Apple Reminders / cron), `wi-sync` (writes scraped data to WI DB)

All 10 currently-`unknown` skills get re-categorized as `auto`. Previously-`write`-class skills `wi-update-context`, `wi-bug-resolve`, `wi-bug-resolve-all`, `wi-bug-report`, `wi-add-bucket`, `wi-skill-install`, `wi-remind`, `wi-sync` are re-evaluated under the new rule and become `auto` because they only touch WI-internal state.

#### `confirm` — anything that affects colleagues OR critical machine state outside WI

Cypher always asks before invoking.

- **Colleague-visible writes:** `wi-save-to-ticket` (posts a comment on a Jira ticket → colleagues see it)
- **Future colleague-visible skills** (don't exist yet): `wi-pr-create`, `wi-pr-comment`, `wi-pr-merge`, Teams-send, email-send
- **Future critical-machine skills** (don't exist yet): system-wide package installs, `~/.bashrc` mods, anything outside the WI repo that could break the machine

#### `cli` — Claude Code skills not Cypher-invokable

Same as before — global skills (`deep-research`, `code-reviewer`, `frontend-design`, etc.) where Cypher recommends and the user types `/skill` themselves.

#### Per-skill metadata (orthogonal to category)

Beyond category, skills can declare:
- `estimated_duration_ms` — Cypher warns "this will take ~Nmin, proceed?" before invoking long-runners regardless of category (e.g. `wi-sync` ~3-5min)
- `requires_confirmation` — explicit override flag if a future read-only skill should still confirm (e.g. expensive paid API call)

These are UX flags, not security gates. The category system stays the security gate.

#### What the system NEVER does

- **No "unknown" category fallback.** Every skill explicitly declares `auto` | `confirm` | `cli`. New skills landing in the catalog without a category are an error condition (smoke check catches this).
- **No silent escalation.** A skill marked `auto` can't decide mid-execution to do something colleague-visible without going through Cypher's confirm path.
- **No per-skill confidence threshold for confirm.** Either it's `auto` (always) or `confirm` (always). No "auto when μ > 0.7."

### D9 — No new HTTP contract for surface symmetry

The dispatch response already includes `category` on the chosen skill. HTTP callers (n8n, MCP, future surfaces) read that field and decide what to do. The brain's decision is identical across surfaces; what differs is what each surface does with the decision. **No contract change required.**

### D-supersedes-033

ADR-033's "depth ≤ 2 / never auto-invoke" is **superseded for `auto`-class only.** Write-class (`confirm`-class) skills (anything writing Jira / repo / 3rd party / critical machine) always confirm. ADR-033 § Surfaces & dispatch should carry an explicit pointer to this ADR.

## Consequences

### What dies

- The current `/wi` SKILL.md "curl + python parse + print + stop" pattern (`skills/wi-router/SKILL.md`) — replaced by SSE-aware streaming consumer.
- The `category='unknown'` enum value in `SKILL_CATALOG` (`src/services/cypher/skills.ts`) — every skill must explicitly declare `auto` | `confirm` | `cli`.
- The 4-way `read | write | cli | unknown` taxonomy — collapses to `auto | confirm | cli`.
- The "depth ≤ 2 invariant" from ADR-033 (for `auto`-class) — replaced by D6 + D8 auto-invoke.

### What changes

- `src/services/cypher/run.ts` — investigate stage stops being a stub (D1.5); plan stage gains an Opus master-plan sub-step for `complexity=heavy` (D1.3); each stage declares `output_kind` metadata (`thinking | findings | signal | decision | side-effect-only`) for D2.B rendering.
- `src/services/cypher/clarify.ts` — `classifyClarity` extends to also surface arg-gap questions (D3 step 3).
- `src/services/cypher/complexity.ts` — `scoreComplexity` adds NL-structure signals (conjunctions, conditional words, multi-action verbs, multi-target references, sequence words) per D4.
- `src/services/cypher/learn.ts` — `getRankedSkills` adds an arg-availability filter (D3 step 2).
- `src/services/cypher/skills.ts` — `SKILL_CATALOG` migrated from 4-way to 3-way taxonomy. `categoryOf()` updated. All currently-`unknown` skills promoted to `auto`. All previously-`write` skills re-evaluated under the new rule.
- `web-server.js` — new `/api/wi/dispatch/stream` endpoint with SSE streaming (D1, D2.A). New `/api/wi/dispatch/classify-prior` endpoint for D7's deferred outcome classification. Existing `/api/wi/dispatch` stays for non-streaming HTTP callers.
- `skills/wi-router/SKILL.md` — rewritten to consume the SSE stream, render per-output-kind (D2.B), invoke `auto`-class skills via the Skill tool, write outcome to queue file (D5) before each step, ask only for `confirm`-class steps (D8).
- New: `skills/wi-resume/SKILL.md` for `/wi --resume <id>` and `/wi --pending` (D5).
- New: `~/.work-intelligence-mcp/queue/` directory for pending state files and `bridge_restart_log.json`.
- ADR-033 — explicit "AMENDED BY ADR-036 § D-supersedes-033" note at the top.
- New smoke sections — § for SSE schema validation (D2.C), § for divergence test (CLI rendered output vs bridge decision JSON), § for `/wi --resume` round-trip, § for category-system has zero `unknown` skills.

### What stays the same

- The bridge as integration layer + persistence + agent host (D1).
- All bridge background agents (BugInvestigator, BugResolver, OrchestratorAgent, etc.).
- The Beta posterior learning loop (`recordSkillOutcomes`) — D7 doesn't add a parallel learner; uses the existing one.
- `src/services/cypher/run.ts` core 9-step contract — refined, not replaced.
- HTTP `/api/wi/dispatch` continues to work for n8n, MCP, future external callers (D9).
- The model-config bucket discipline (per `.claude/rules/model-config.md`).

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| SSE stream silently produces wrong rendering | Schema enforcement + smoke divergence test (D2.C) |
| Bridge unreachable corrupts user state | Queue file written BEFORE every risky operation; `/wi --resume` recovers (D5) |
| `auto`-class skills do something colleague-visible at runtime (escaped categorization) | Smoke sweep verifies every `auto` skill never imports the github-tools / jira MCP write methods. Hard gate. |
| Cold-start saved-context pull is slow | Cache the prefix at 1h TTL; cold start happens at most once per session per hour |
| Plan stage's Opus master-plan call is expensive | Only fires for `complexity=heavy` dispatches; light dispatches stay deterministic; per-bucket model config remains user-tunable |
| Outcome classifier (D7 Haiku call) misreads user's next message | Default-to-`mixed` when ambiguous; `mixed` doesn't move the prior, so misclassification doesn't corrupt learning |
| Cross-call cache invalidation when priors actually update | Priors update is a small delta; cache prefix can include a "priors hash" so changes invalidate gracefully without rebuilding everything |

### Migration order

Suggested phasing for PLAN.md (subject to PLAN.md detailed work):

1. **Catalog migration** — rename `read → auto`, `write → confirm`, eliminate `unknown` (move all 10 to `auto`), update `categoryOf()`. Smoke gate verifies no `unknown` remains.
2. **Investigate stage** — replace stub with real saved-context pull from palace + brain + sessions + claude-mem (D1.5).
3. **Cacheable-prefix prompt structure** — restructure Cypher's LLM calls (clarify, plan) so the system prompt + catalog summary + saved-context payload is the cacheable prefix with `cache_control: { type: 'ephemeral', ttl: '1h' }` (D1.4).
4. **SSE endpoint** — `/api/wi/dispatch/stream` with per-stage event schema (D2.A, D2.C).
5. **`scoreComplexity` NL-structure signals** (D4).
6. **Plan stage Opus sub-step** — Anthropic `analyse` bucket call for `complexity=heavy` master-plan generation (D1.3).
7. **Argument-availability filter in `getRankedSkills`** (D3 step 2).
8. **CLI SKILL.md rewrite** — SSE consumer, per-output-kind rendering, Skill-tool invocation for `auto`, queue-file writes for D5.
9. **`/wi --resume` and `/wi --pending`** (D5).
10. **Outcome classifier on user's next message** — new endpoint `POST /api/wi/dispatch/classify-prior` (Haiku, agents bucket). Triggered async-on-next-`/wi` from the SKILL.md when a pending-classification session exists for this user. Flips `mixed → success | failed` per D7. Pending classifications expire after 24h.
11. **D1.2 (model-per-stage mapping)** — design discussion AFTER the above lands so we know each stage's actual cognitive demand.
12. **v2 CypherAgent** — long-lived in-bridge agent (separate phase after v1 soaks).

## Open question

**D1.2** — model-per-stage mapping table. Maaz pushed back on the assistant's proposed mapping (Haiku for ask/research/QG, Opus for plan, varies for execute). The right table is its own design discussion, picked up after PLAN.md outline is sketched. Resolution before code lands, but not before this ADR can be Proposed.

## What this ADR explicitly does NOT decide

- **Chat brain unification** (Phase 85 / ADR-035) — parked. The `/api/chat` surface keeps its bespoke pipeline until that ADR is unparked.
- **UI / web ChatPanel shape** — no preferred shape exists yet; design deferred.
- **n8n / external automation** — they continue to use HTTP. No special accommodation in this ADR.
- **MCP `wi_dispatch` tool behavior** — unchanged. It's an HTTP caller via the bridge.

## References

- `skills/wi-router/SKILL.md` — the slash command being redesigned
- `src/services/cypher/run.ts` — the canonical brain
- `src/services/cypher/skills.ts` — `SKILL_CATALOG`
- `src/services/cypher/clarify.ts` — `classifyClarity`
- `src/services/cypher/complexity.ts` — `scoreComplexity`
- `src/services/cypher/learn.ts` — `getRankedSkills`, `recordSkillOutcomes`
- `src/services/model-config.ts` — `bucketCallParams`
- ADR-024 — Unified Brain pillar (the bridge's role as integration layer)
- ADR-033 — Cypher framework (depth-≤2 invariant superseded by D-supersedes-033)
- ADR-034 — Cypher learning autonomy engine (Beta loop, calibration substrate)
- BRAINSTORM at `.planning/phases/86-cypher-cli-primary/BRAINSTORM.md` — full walkthrough record with assistant's rejected proposals and Maaz's reframings
- Commit `b8fdace` — full toolbox + clarify
- Commit `0b7c3e1` — work-context vocab band-aid (the symptom that exposed the brain split that ADR-035 covers and ADR-036 starts to fix from the CLI side)
