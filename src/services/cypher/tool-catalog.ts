/**
 * src/services/cypher/tool-catalog.ts — ADR-037 Phase 2 (2026-06-22).
 *
 * The production tool catalog the v2.0 loop controller exposes to the
 * Anthropic SDK. Hand-written per ADR-037 D21 / Q-1.5 (Option A is the
 * v2.0 mechanism). Codegen-from-SKILL.md is v2.5 W2 work; runtime
 * self-registration (Option C) is a v2.5 tracked open question with a
 * high-bar promotion gate — neither is in scope here.
 *
 * **Scaffold state (2026-06-22).** This file defines the `ToolDefinition`
 * shape and exports an empty `TOOL_CATALOG`. The body fills in across
 * subsequent commits on the `cypher-loop-phase-2` branch — one tool per
 * commit OR grouped by source (all `wi-*`, all `brain.*`, etc.) to keep
 * code review tractable.
 *
 * The three default-shape rules (D21 / v2.0 PRD § 4.5) — every new
 * `ToolDefinition` MUST follow these unless declaring `codegen_exempt`:
 *
 *   1. `posture_eligibility: string[]` — list of posture names, NOT a
 *      predicate function. v2.5 W2 codegen reads this declaratively.
 *   2. `input_schema: <JSON schema literal>` — static object, NOT a
 *      runtime-built schema. Predictability for the codegen audit.
 *   3. `description: string` OR `description_from: 'SKILL.md'` — no
 *      runtime assembly. The Beta-prior augmentation (`prior_mu`) goes
 *      through a separate path so it doesn't break this rule.
 *
 * Any of the three may be opted out per-field via a `codegen_exempt`
 * declaration with a plain-text `reason`. v2.0 acceptance gate target:
 * N=0 exempt skills at Phase 2 close. N>0 is not a blocker but signals
 * the default rules need review before Phase 6.
 *
 * `category: 'cli'` tools are **excluded** from the loop's exposed
 * catalog — Cypher recommends them; the user types the slash command
 * (ADR-036 D8 surface contract).
 *
 * Cross-references:
 *   - ADR-037 D21 (`docs/docs/adr/adr-037-cypher-tool-use-loop.md`)
 *   - Cypher v2.0 PRD § 4.5 (`docs/docs/prd/cypher-v2.0.md`)
 *   - Execution plan § 2 (`.planning/cypher/11-ADR-037-EXECUTION-PLAN.md`)
 *   - CAP-13 friction ledger: `cap13_birth_decisions` table (v66)
 *   - Phase 1 spike learnings (`.planning/cypher/14-SPIKE-LEARNINGS.md`)
 *     — tool description voice, FTS5 syntax gotcha, tool_result trimming
 */

import type Database from 'better-sqlite3';
import type { PalaceClient } from '../../intelligence/palace-client.js';
import type { SkillCategory } from './skills.js';
import { recallMemory } from '../brain/recall.js';
import { runDecision } from '../brain/decision-engine.js';
import { verifyClaim } from '../brain/verify.js';
import { buildBrainContext } from '../brain/context-builder.js';
import { searchMessages } from '../../db/queries/messages.js';
import {
  getBlastRadius,
  getTestCoverage,
  getFileOwners,
} from '../../db/queries/code-graph.js';
import { CodeIndexer } from '../../tools/code-indexer.js';
import { ConfigManager } from '../config.js';
import {
  tryAcquireCodeGraphLock,
  releaseCodeGraphLock,
} from '../code-graph/lock.js';
import { withCodeGraphIndexDeadline } from '../code-graph/deadline.js';
import { getWiConfig } from '../wi-config.js';
import {
  createTask,
  getTask,
  listTasks,
  closeTask,
  loadTaskContext,
  renderTaskContextBlock,
  recurateTaskContext,
} from './task-memory.js';
import {
  createProject,
  listProjects,
} from './projects.js';
// Phase-0 M1: dispatchability filter (env STAGE1_DISPATCHABLE_ONLY=1).
// Used by getCatalogHintWordOverlap (sync, module-level import required).
// getCatalogHint uses a dynamic import inside its async body — no top-level
// dependency needed there. See ADR-050 + BUILD-PLAN-01-PHASE0.md.
import { DISPATCHABLE_SKILLS as DISPATCHABLE_SKILLS_WORDPATH } from './skill-dispatch.js';

// ---------------------------------------------------------------------------
// Phase 2 wi.* stub helper
// ---------------------------------------------------------------------------

/**
 * Phase 2 wi.* handler stub. Every wi-* skill in SKILL_CATALOG has a
 * TOOL_CATALOG entry whose handler returns this shape — schema validation
 * runs against a real `input_schema`, but the handler body is deferred to
 * Phase 3 when the loop controller lands. Until then the bridge keeps
 * serving these skills via their existing /api/wi/dispatch path; the
 * loop's stub return tells the model "I see the skill, but the in-loop
 * handler is not wired yet — recommend the user run the slash command".
 *
 * ADR-040 commit 4 (2026-07-06): all 19 wi_* handlers now dispatch
 * through runSkillSubagent. The STUB helper is retired; the wi-router
 * skill's fallback path preserves the "recommend slash command" UX for
 * users who invoke skills outside the loop.
 */

// ---------------------------------------------------------------------------
// Posture vocabulary (v2.0 PRD § 4.4)
// ---------------------------------------------------------------------------

/**
 * Postures are the operating modes the loop runs under. Each
 * `ToolDefinition` declares which postures may invoke it. v2.0 shipped
 * with the first four; ADR-053 adds `'architect'` and `'pm-resume'` for
 * the multi-stage PM tier (matching the v108 posture CHECK constraint).
 */
export type Posture =
  | 'pr-review'
  | 'bug-investigate'
  | 'pm'
  | 'generic'
  | 'architect'
  | 'pm-resume';

// ---------------------------------------------------------------------------
// ADR-039 AC-5 — phase eligibility (scope vs execute)
// ---------------------------------------------------------------------------

/**
 * ADR-039 AC-5 — when may this tool run?
 *
 *   - `'scope'`   — only during the goal-refinement (scope) phase.
 *                   Reserved; nothing currently declares this.
 *   - `'execute'` — only during the execute phase. fs / repo /
 *                   external-state mutators (writes, commits, push,
 *                   subprocess spawns, irreversible Anthropic / Jira
 *                   side-effects) MUST declare this so the scope-phase
 *                   refiner cannot accidentally invoke them.
 *   - `'both'`    — read-only tools that are safe in either phase.
 *                   Default for every tool that does not declare a
 *                   value.
 *
 * The scope-phase refiner builds its tool surface via
 * `getCatalogForPhase('scope')`, which excludes every `'execute'`
 * tool at the registry level. ADR-039 AC-23 cross-references this
 * file from the discipline rule for the same reason — defense in
 * depth: the rule documents the policy, the registry enforces it.
 */
export type ScopeOrExecutePhase = 'scope' | 'execute' | 'both';

// ---------------------------------------------------------------------------
// Codegen-exempt escape hatch (D21 rule 2)
// ---------------------------------------------------------------------------

/**
 * Per-field opt-out from the three default-shape rules. Each exempt
 * skill MUST declare a plain-text `reason` — read by v2.5 W2 audit and
 * code reviewers to confirm the exemption is justified rather than
 * lazy. `fields` enumerates which rules this tool opts out of; the
 * other rules still apply.
 *
 * At v2.0 Phase 2 close: target N=0 exempt skills across the catalog.
 * If Phase 2 ships with N>0, the v2.0 acceptance gate flags this for
 * review before Phase 6.
 */
export interface CodegenExempt {
  /** Why this skill can't follow the default rule. Read by humans. */
  reason: string;
  /** Which default-shape rules this skill opts out of. */
  fields: Array<'posture_eligibility' | 'input_schema' | 'description'>;
}

// ---------------------------------------------------------------------------
// ToolDefinition shape (execution plan § 2.2 + D21)
// ---------------------------------------------------------------------------

/**
 * One row in the tool catalog. The Anthropic SDK consumes a transformed
 * subset of this shape (`name` / `description` / `input_schema`); the
 * extra fields (`category`, `posture_eligibility`, `estimated_duration_ms`,
 * `handler`) drive the loop's own logic (confirm-gate, posture filter,
 * timeout enforcement, dispatch).
 */
export interface ToolDefinition {
  /** Tool name as the SDK sees it. Convention: `<source>_<verb>` snake_case. */
  name: string;

  /**
   * Tool description as the SDK sees it. Either a static string OR a
   * marker that tells codegen to read the description out of the
   * referenced SKILL.md frontmatter at build time. Per D21 rule 3,
   * runtime assembly is NOT permitted — the Beta-prior augmentation
   * (`prior_mu`) the loop wants is appended at the SDK-call boundary,
   * not here.
   */
  description: string | { description_from: 'SKILL.md'; skill: string };

  /**
   * Loop category. `'cli'` tools are excluded from the loop's exposed
   * catalog (ADR-036 D8). `'confirm'` tools require a standing grant
   * OR explicit per-call confirmation. `'auto'` tools fire without
   * gating.
   */
  category: SkillCategory;

  /** D21 rule 1 — list of posture names, NOT a predicate function. */
  posture_eligibility: Posture[];

  /** D21 rule 2 — JSON schema literal, NOT a runtime-built object. */
  input_schema: Record<string, unknown>;

  /** Soft hint for the loop's per-tool timeout. The real cap is in the handler. */
  estimated_duration_ms: number;

  /**
   * Tool body. `ctx` carries the DB, the live PalaceClient (or null),
   * the dispatch's session_id, and any other state the handler needs.
   * Returns whatever JSON-serialisable payload the loop should pass
   * back to the model as the tool_result content.
   *
   * Per Phase 1 spike learning #5: trim tool_result payloads here, not
   * downstream. ~1KB cap per result keeps the message history light.
   */
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

  /** Per-field opt-out from the three default-shape rules. Omit when N=0. */
  codegen_exempt?: CodegenExempt;

  /**
   * ADR-039 T5 (AC-6) — whether the loop dispatcher may execute this
   * tool concurrently with sibling tool_use blocks from the same
   * iteration.
   *
   *   true / undefined (default) — read-only or commutative work; safe
   *       to Promise.all alongside other parallelizable tools.
   *   false — state mutators (DB writes, subprocess spawns, external
   *       sends, fire-and-forget locks). The dispatcher runs these
   *       serially AFTER the parallel batch completes, preserving
   *       single-writer semantics.
   *
   * Within a single iteration the final `tool_result[]` ordering
   * matches the original `tool_use[]` order regardless of execution
   * grouping — the model never sees the partition.
   */
  parallelizable?: boolean;

  /**
   * ADR-038 v2.5 D5 — three-tier risk classification.
   *
   *   1 — Reversible local: file edits in worktree, reads, palace
   *       writes, claude_mem writes, cypher.record_outcome. No friction.
   *   2 — Reversible-ish: git.commit on cypher/task_*, smoke.run,
   *       typecheck.run, apple-reminders.add, obsidian.write. Grantable;
   *       defaults to one_shot.
   *   3 — Irreversible / colleague-visible: git.push, jira.comment,
   *       teams.send, email.send, git.merge to non-Cypher branches,
   *       bug.resolve_attempt, wi-pr-review-post. **NEVER grantable —
   *       always asks. Ledger ignored entirely.**
   *
   * Default for tools that don't declare: tier 1 (least dangerous
   * inference — anything that doesn't say it's risky probably isn't).
   * The loop's confirm-gate enforces the tier-3 short-circuit.
   */
  risk_tier?: 1 | 2 | 3;

  /**
   * ADR-039 AC-5 — phase eligibility (scope vs execute).
   *
   * Default (when omitted): `'both'`. Read-only tools are safe in
   * either phase and don't need to declare a value. Tools that mutate
   * fs / repo / external state MUST declare `'execute'` so the
   * scope-phase refiner cannot see (and therefore cannot invoke)
   * them. The registry filter `getCatalogForPhase('scope')` is the
   * enforcement site cross-referenced from `.claude/rules/cypher-discipline.md`
   * (AC-23 verification clause).
   */
  phase?: ScopeOrExecutePhase;
}

/**
 * Context passed to every tool handler. Read-only access; handlers must
 * not mutate it. Future fields (cancellation signal, budget tracker)
 * land here per Phase 3 work.
 */
export interface ToolContext {
  db: Database.Database;
  user: string;
  session_id: string;
  /** Optional palace client. Null when palace is disabled / unconnected. */
  palace: PalaceClient | null;
  /**
   * ADR-038 v2.5 D8 — the loop's posture + task_class for this
   * dispatch. The cypher.self_assess tool's handler needs both to
   * route the aggregation tier. Optional so existing handlers
   * unaffected — when absent, self_assess falls back to T3.
   */
  posture?: Posture;
  task_class?: string;
}

// ---------------------------------------------------------------------------
// Repo name resolution (config-driven — OSS sanitization)
// ---------------------------------------------------------------------------

const REPO_ENUM: string[] = (() => {
  try {
    const names = (getWiConfig().repos ?? []).map(r => r.name);
    if (names.length > 0) return names;
  } catch { /* config missing — fall through */ }
  const fallback: string[] = [];
  if (process.env.REPO_PATH) fallback.push('workspace');
  if (process.env.OPERATIONS_PATH) fallback.push('operations');
  return fallback.length > 0 ? fallback : ['app', 'ops'];
})();

const DEFAULT_REPO: string = REPO_ENUM[0] ?? 'app';

const REPO_ENUM_WITH_ALL: string[] = [...REPO_ENUM, 'all'];

// ---------------------------------------------------------------------------
// The catalog itself
// ---------------------------------------------------------------------------

/**
 * The production tool catalog. Filled across subsequent Phase 2 commits.
 * Order of population (one commit per group):
 *
 *   1. brain.* (4 tools)            — recall, decide, verify, context
 *   2. palace.* (2 tools)           — search, recall
 *   3. fts (1 tool)                 — full-text search
 *   4. code_graph.* (~3-5 tools)    — blast-radius, owners, file-search
 *   5. wi.* (19 tools)              — every SKILL_CATALOG entry
 *   6. smoke.run, typecheck.run     — sandbox-bounded verification
 *   7. clarify, cypher.record_outcome — loop infrastructure
 *
 * Expected final size: 30–40 tool definitions.
 */
export const TOOL_CATALOG: ToolDefinition[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // brain.* — 4 tools (recall, decide, verify, context)
  //
  // Phase 1 spike learnings honored (.planning/cypher/14-SPIKE-LEARNINGS.md):
  //   - Descriptions are verb-first, name when-to-call AND when-not-to-call,
  //     and skip return-type listings (the model doesn't read them).
  //   - Handlers trim payloads to ~1KB each — message history is the cost
  //     driver, not the system prompt. Full results stay queryable via
  //     `/api/brain/decision/:id` and similar endpoints.
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'brain_recall',
    description:
      'Recall similar past decisions, clusters, and palace drawers for a goal pattern. Use early in dispatch to ground reasoning in prior work — call ONCE per dispatch, near the start.',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 500,
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'natural-language goal or keyword',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      required: ['pattern'],
    },
    handler: async (input, ctx) => {
      const pattern = String(input.pattern ?? '');
      const limit = typeof input.limit === 'number' ? input.limit : 5;
      const results = await recallMemory({
        db: ctx.db,
        pattern,
        limit,
        palace: ctx.palace,
      });
      // Trim per Phase 1 spike rule #5: ~1KB per result. Snippet truncated
      // to 240 chars; source/id/confidence/score preserved so the model can
      // reason about provenance without dragging the full body into history.
      return results.map((r) => ({
        source: r.source,
        id: r.id,
        snippet: r.snippet?.slice(0, 240) ?? '',
        confidence: r.confidence,
        score: r.score,
      }));
    },
  },
  // ADR-038 v2.5 D8 — cypher.self_assess. Read-only introspection over
  // the loop's own Beta-prior track record at (posture, task_class,
  // user). Pre-loop the loop renders this directly into the system
  // prompt (see runLoop); the tool entry below lets the model call
  // self_assess mid-loop if the goal shifts (e.g. user pivots from
  // analysis to fixing — "should I escalate?"). Single SQLite
  // aggregation, cached 60s. No LLM call.
  {
    name: 'cypher_self_assess',
    description:
      "Read Cypher's own track record on (posture, task_class, user). Returns confidence (Beta posterior), tier_used (T0–T3), n_similar_tasks, recent_success_rate, typical_cost_usd, failure_modes, and a recommendation ('proceed' | 'proceed_with_caution' | 'decline'). Call when the goal shifts mid-loop or you suspect you're heading into a track-record-weak area. Cheap; do NOT call more than 2× per dispatch.",
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            "Optional override of the current dispatch's goal text. Defaults to the dispatch goal when omitted.",
        },
        task_class: {
          type: 'string',
          description:
            "Optional override of the current task_class. Defaults to the dispatch's task_class when omitted.",
        },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      // Lazy import to avoid a load-time cycle with loop.ts which
      // imports tool-catalog.ts for the Posture type + catalog.
      const { selfAssess } = await import('./self-assess.js');
      const goal = typeof input.goal === 'string' ? input.goal : '';
      const task_class =
        typeof input.task_class === 'string' && input.task_class
          ? input.task_class
          : ctx.task_class ?? 'generic';
      const posture = ctx.posture ?? 'generic';
      return selfAssess(ctx.db, {
        goal,
        posture,
        user: ctx.user,
        task_class,
      });
    },
  },
  {
    name: 'brain_decide',
    description:
      'Generate a structured decision with rationale + evidence + alternatives for a specific question. EXPENSIVE — uses the `decide` bucket (Opus 4.8 / max) and writes to brain_decisions. Reserve for genuinely novel questions, not lookups.',
    category: 'confirm',
    // D5 — tier 2: expensive but reversible; write is local SQLite.
    risk_tier: 2,
    // ADR-039 AC-5 — writes brain_decisions row + Anthropic decide call.
    phase: 'execute',
    // T5 (AC-6): writes to brain_decisions — single-writer required.
    parallelizable: false,
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 25000,
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'the decision to resolve',
        },
      },
      required: ['question'],
    },
    handler: async (input, ctx) => {
      const question = String(input.question ?? '');
      const r = await runDecision({
        db: ctx.db,
        question,
        user: ctx.user,
        // Dispatch comes from the loop, treated as an MCP consumer per the
        // brain budget allocator's existing consumer split.
        consumer: 'mcp',
        palace: ctx.palace,
      });
      // Drop `evidence` from the trimmed return — too large for message
      // history. Caller can re-fetch via /api/brain/decision/:id when the
      // full evidence list is needed for surfacing to the user.
      return {
        decision_id: r.decision_id,
        decision: r.decision,
        rationale: r.rationale ? r.rationale.slice(0, 400) : null,
        confidence: r.confidence,
        cache_hit: r.cache_hit,
        next_actions: r.next_actions.slice(0, 5),
        alternatives: r.alternatives.slice(0, 3),
      };
    },
  },
  {
    name: 'brain_verify',
    description:
      "Verify a factual claim against authoritative sources (GitHub MCP, Jira MCP, code grep, build logs). Use when a claim's truth matters for the next action — don't use for opinion-shaped claims or when grounding already exists in palace.",
    category: 'confirm',
    // D5 — tier 2: hits external MCP servers (GitHub/Jira) but read-only.
    risk_tier: 2,
    // ADR-039 AC-5 — execute-phase: hits external MCP servers, not a read-only scope probe.
    phase: 'execute',
    // T5 (AC-6): writes to brain_verifications — single-writer required.
    parallelizable: false,
    posture_eligibility: ['pr-review', 'bug-investigate', 'generic'],
    estimated_duration_ms: 8000,
    input_schema: {
      type: 'object',
      properties: {
        claim: { type: 'string' },
        evidence_needed: {
          type: 'array',
          items: { type: 'string' },
          description:
            'list of verifier specs, e.g. ["jira:JIRA-15702", "github:org/repo#1234"]',
        },
      },
      required: ['claim', 'evidence_needed'],
    },
    handler: async (input, ctx) => {
      const claim = String(input.claim ?? '');
      const evidence_needed = Array.isArray(input.evidence_needed)
        ? input.evidence_needed.map((s) => String(s))
        : [];
      const r = await verifyClaim({ db: ctx.db, claim, evidence_needed });
      return {
        id: r.id,
        verified: r.verified,
        confidence: r.confidence,
        evidence: r.evidence.slice(0, 500),
        result_count: r.results.length,
      };
    },
  },
  {
    name: 'brain_context',
    description:
      "Fetch the current operational context for the user: sprint, stuck Jiras, today's calendar, open investigations, stale warnings. Use when the goal touches the user's active work state — skip otherwise.",
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 800,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_input, ctx) => {
      const c = await buildBrainContext(ctx.db, ctx.user, { palace: ctx.palace });
      // Trim philosophy mirrors PHASE-86-02-C investigate.ts: flatten to a
      // scannable findings list, cap collections that empirically blow the
      // message budget. The 551 stale_warnings observed in production is the
      // documented worst case.
      return {
        sprint: c.sprint,
        stuck_jiras: c.stuck_jiras.slice(0, 10),
        calendar_today: c.calendar_today,
        open_investigations: c.open_investigations,
        stale_warnings: c.stale_warnings.slice(0, 10),
        truncated: {
          stuck_jiras: c.stuck_jiras.length > 10,
          stale_warnings: c.stale_warnings.length > 10,
        },
      };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // palace.* — 2 tools (search, recall)
  //
  // Both handlers guard against ctx.palace == null (palace disabled). When
  // the underlying client returns a string that parses as a JSON array, the
  // handler normalizes the top 10 entries to a flat shape with a 240-char
  // snippet. When the string is not parseable JSON, we return a truncated
  // raw shape so the model still sees the body (rare; the palace MCP
  // currently emits JSON).
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'palace_search',
    description:
      'Search the MemPalace semantically across all wings for drawers matching a natural-language query. Use to ground reasoning in prior captured context (decisions, meetings, investigations, code notes). Skip when ctx already has the relevant palace recall from brain_recall.',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 1500,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'natural-language search query',
        },
        wing: {
          type: 'string',
          description: 'optional wing filter (e.g. decisions, meetings, code)',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      required: ['query'],
    },
    handler: async (input, ctx) => {
      if (!ctx.palace) return [];
      const query = String(input.query ?? '');
      const wing = input.wing != null ? String(input.wing) : undefined;
      const limit = typeof input.limit === 'number' ? Math.min(input.limit, 20) : 5;
      const raw = await ctx.palace.search(query, wing, limit);
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.slice(0, 10).map((r: unknown) => {
            const rec = (r ?? {}) as Record<string, unknown>;
            return {
              wing: rec.wing != null ? String(rec.wing) : undefined,
              room: rec.room != null ? String(rec.room) : undefined,
              id: rec.id != null ? String(rec.id) : undefined,
              snippet:
                rec.content != null
                  ? String(rec.content).slice(0, 240)
                  : rec.snippet != null
                    ? String(rec.snippet).slice(0, 240)
                    : '',
              score: typeof rec.score === 'number' ? rec.score : undefined,
            };
          });
        }
      } catch {
        // fall through to truncated raw
      }
      return { raw: raw.slice(0, 1024) };
    },
  },
  {
    name: 'palace_recall',
    description:
      'Recall drawers from a specific MemPalace wing, optionally filtered by query. Use when the relevant wing is known (e.g. "decisions" or "investigations") and you want recent or query-matched entries from that wing only. Prefer palace_search when the wing is unknown.',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 800,
    input_schema: {
      type: 'object',
      properties: {
        wing: {
          type: 'string',
          description: 'wing name to recall from (e.g. decisions, meetings, code, investigations)',
        },
        query: {
          type: 'string',
          description: 'optional query; when omitted, recall most recent drawers in the wing',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      required: ['wing'],
    },
    handler: async (input, ctx) => {
      if (!ctx.palace) return [];
      const wing = String(input.wing ?? '');
      const query = input.query != null ? String(input.query) : undefined;
      const limit = typeof input.limit === 'number' ? Math.min(input.limit, 20) : 5;
      const args: Record<string, unknown> = { wing, limit };
      if (query) args.query = query;
      const raw = await ctx.palace.callToolRaw('mempalace_recall', args);
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.slice(0, 10).map((r: unknown) => {
            const rec = (r ?? {}) as Record<string, unknown>;
            return {
              wing: rec.wing != null ? String(rec.wing) : wing,
              room: rec.room != null ? String(rec.room) : undefined,
              id: rec.id != null ? String(rec.id) : undefined,
              snippet:
                rec.content != null
                  ? String(rec.content).slice(0, 240)
                  : rec.snippet != null
                    ? String(rec.snippet).slice(0, 240)
                    : '',
              created_at: rec.created_at != null ? String(rec.created_at) : undefined,
            };
          });
        }
      } catch {
        // fall through to truncated raw
      }
      return { raw: raw.slice(0, 1024) };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // fts — 1 tool (search the WI BM25 FTS5 messages index)
  //
  // Bypasses the /api/search-all route handler — that path does live
  // Outlook + Jira browser fetches and can take 5+ minutes. The loop wants
  // a 1200ms in-process probe over the already-synced messages table, which
  // is exactly what searchMessages() does. sortBy='recency' re-sorts a
  // wider FTS window on timestamp DESC since the underlying function does
  // not expose an order knob.
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'fts_search',
    description:
      'Find messages across Jira, Teams, Email, and GitHub via the WI BM25 FTS5 index. Use when you need verbatim quotes, source IDs, or evidence snippets for a keyword or phrase. Skip when the goal is semantic recall of past decisions — use brain_recall for that.',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 1200,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'FTS5 keywords or phrase to search the messages index',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        sortBy: {
          type: 'string',
          enum: ['relevance', 'recency'],
          default: 'relevance',
        },
      },
      required: ['query'],
    },
    handler: async (input, ctx) => {
      const query = String(input.query ?? '').trim();
      const limit =
        typeof input.limit === 'number'
          ? Math.max(1, Math.min(50, Math.floor(input.limit)))
          : 10;
      const sortBy = input.sortBy === 'recency' ? 'recency' : 'relevance';
      if (!query) return [];
      // Pull a slightly wider window when sortBy=recency so re-sorting has signal.
      const fetchLimit = sortBy === 'recency' ? Math.min(50, limit * 3) : limit;
      const rows = searchMessages(ctx.db, {
        search_text: query,
        limit: fetchLimit,
      });
      const ranked =
        sortBy === 'recency'
          ? [...rows].sort((a, b) => {
              const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
              const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
              return tb - ta;
            })
          : rows;
      return ranked.slice(0, limit).map((m, idx) => ({
        source: m.source,
        id: m.id,
        snippet: (m.subject ? `${m.subject} — ` : '').concat(m.content ?? '').slice(0, 240),
        score: sortBy === 'relevance' ? rows.length - idx : null,
        ts: m.timestamp ?? null,
      }));
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // code_graph.* — 4 tools (blast_radius, owners, test_coverage, reindex)
  //
  // Direct in-process imports from src/db/queries/code-graph.ts — same
  // functions web-server.js's /api/code-graph/* routes call. The reindex
  // tool replicates the bridge's lock-acquire-before-202 pattern (ADR-027
  // v2 item #3) so the loop cannot deadlock the indexer. 'pm' posture is
  // intentionally absent — these are dev/IC tools, not PM read-only
  // orchestration.
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'code_graph_blast_radius',
    description:
      'List direct and transitive dependents of a file in a configured repo. Use when sizing a PR risk, planning a refactor, or asking "what else does this break?". Do NOT call for files you have not confirmed exist — pass a repo-relative path that matches the indexed tree.',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'generic'],
    estimated_duration_ms: 800,
    input_schema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          enum: REPO_ENUM,
          description: 'configured repo name',
        },
        file: {
          type: 'string',
          description: 'repo-relative file path, e.g. src/auth/login.ts',
        },
      },
      required: ['repo', 'file'],
    },
    handler: async (input, ctx) => {
      const repo = String(input.repo ?? '');
      const file = String(input.file ?? '');
      const nodes = getBlastRadius(ctx.db, repo, file);
      const crossRepoImpact = nodes.some((n) => n.repo !== repo);
      const trimmed = nodes.slice(0, 50).map((n) => ({
        file: n.file_path,
        repo: n.repo,
        depth: n.depth,
        kind: n.ref_type || 'ref',
      }));
      return {
        repo,
        file,
        dependents: trimmed,
        total: nodes.length,
        truncated: nodes.length > 50,
        crossRepoImpact,
      };
    },
  },
  {
    name: 'code_graph_owners',
    description:
      'List code owners for a file — CODEOWNERS entries plus recent contributors ranked by commit count. Use before tagging a reviewer or routing a bug. Returns empty list when the team_members enrichment has not run yet for that repo; treat empty as "unknown owner", not "no owner".',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'generic'],
    estimated_duration_ms: 500,
    input_schema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          enum: REPO_ENUM,
          description: 'configured repo name',
        },
        file: {
          type: 'string',
          description: 'repo-relative file path',
        },
      },
      required: ['repo', 'file'],
    },
    handler: async (input, ctx) => {
      const repo = String(input.repo ?? '');
      const file = String(input.file ?? '');
      const owners = getFileOwners(ctx.db, repo, file);
      const trimmed = owners.slice(0, 10).map((o) => ({
        login: o.github_handle,
        kind: 'contributor' as const,
        commits: o.commit_count,
      }));
      return {
        repo,
        file,
        owners: trimmed,
        total: owners.length,
        truncated: owners.length > 10,
      };
    },
  },
  {
    name: 'code_graph_test_coverage',
    description:
      'Find tests that exercise a given file in a configured repo. Use when proposing a fix to estimate which test files will need to run, or when triaging a bug to see which tests should already have caught it. The lookup keys on the indexed test_covers edges — empty result means no test currently links to this file (gap, not safe).',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'generic'],
    estimated_duration_ms: 1500,
    input_schema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          enum: REPO_ENUM,
          description: 'configured repo name',
        },
        file: {
          type: 'string',
          description: 'repo-relative file path',
        },
      },
      required: ['repo', 'file'],
    },
    handler: async (input, ctx) => {
      const repo = String(input.repo ?? '');
      const file = String(input.file ?? '');
      const testFiles = getTestCoverage(ctx.db, [{ repo, file }]);
      const config = new ConfigManager();
      const repos = config.getRepos();
      const repoConfig = repos.find((r) => r.name === repo);
      const trimmed = testFiles.slice(0, 20);
      return {
        repo,
        file,
        testFiles: trimmed,
        total: testFiles.length,
        truncated: testFiles.length > 20,
        command: repoConfig ? `cd ${repoConfig.localPath} && ${repoConfig.testCmd}` : null,
      };
    },
  },
  {
    // T5 (AC-6): acquires per-repo code-graph lock + fire-and-forget
    // index. Serialise so two simultaneous reindexes don't both try
    // to claim the same lock.
    parallelizable: false,
    name: 'code_graph_reindex',
    description:
      'Force a code-graph re-index of configured repos. Use after a fresh rsync or when blast_radius/test_coverage look stale. Burns CPU for 1-10 min per repo and holds the per-repo lock — do not call casually, and never in a tight loop. Returns immediately with 202 status; indexing continues in background.',
    category: 'confirm',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'generic'],
    estimated_duration_ms: 60000,
    input_schema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          enum: REPO_ENUM_WITH_ALL,
          description: "which repo to reindex; 'all' indexes all configured repos",
        },
      },
      required: ['repo'],
    },
    handler: async (input, ctx) => {
      const repo = String(input.repo ?? '');
      const targetRepoNames = repo === 'all' ? REPO_ENUM : [repo];
      const acquired = tryAcquireCodeGraphLock(targetRepoNames);
      if (!acquired.ok) {
        return {
          accepted: false,
          repo,
          error: 'code-graph busy',
          busy: acquired.busy,
        };
      }
      const config = new ConfigManager();
      const repos = config.getRepos();
      const indexer = new CodeIndexer(ctx.db, repos);
      const targetRepos = repo === 'all' ? repos.map((r) => r.name) : [repo];
      // Fire-and-forget — the indexer agent owns the lock until it finishes.
      Promise.all(
        targetRepos.map((rn) =>
          withCodeGraphIndexDeadline(indexer.indexRepo(rn), `indexRepo ${rn}`).catch(
            (err: Error) => ({ __error: err, repo: rn }),
          ),
        ),
      ).finally(() => releaseCodeGraphLock(targetRepoNames));
      return { accepted: true, repo, targets: targetRepos };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // wi.* — 19 tools (every SKILL_CATALOG entry)
  //
  // Phase 2 ships catalog entries with REAL input_schemas (ajv-valid) and
  // STUB handler bodies. Phase 3 wires real handlers. Until then the bridge
  // continues to serve these skills through /api/wi/dispatch; the loop's
  // STUB return is what the model sees when it tries to invoke a wi-* tool
  // in-loop — it tells the loop to surface the slash command instead.
  //
  // Categories copied verbatim from SKILL_CATALOG: 18× auto, 1× confirm
  // (wi_save_to_ticket). No 'cli' emitted — cli is a surface convention,
  // not a catalog category for the loop.
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'wi_search',
    description:
      'Fast LOCAL-ONLY search across the already-synced Jira / Teams / Email / GitHub messages (WI FTS5 index — no live fetch). Use as a broad first-pass when grounding a goal in prior work. For an exhaustive LIVE fetch + extraction across all sources, use wi_search_all (execute phase only — it browser-scrapes and is slow).',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 1000,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'free-text search query' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
    },
    handler: async (input, ctx) => {
      // LOCAL-ONLY (2026-07-15): previously dispatched the wi-search skill,
      // which hits /api/search-all → a live Outlook + Jira browser scrape
      // (90s Outlook timeout) that blew the SCOPE wall-clock budget when the
      // refiner called it. wi_search is a scope-eligible read, so it MUST be
      // cheap and local — query the synced FTS index directly (same path as
      // fts_search). The live fetch lives in wi_search_all (execute-only).
      const query = String(input.query ?? '').trim();
      const limit =
        typeof input.limit === 'number'
          ? Math.max(1, Math.min(50, Math.floor(input.limit)))
          : 10;
      if (!query) return [];
      return searchMessages(ctx.db, { search_text: query, limit });
    },
  },
  {
    name: 'wi_investigate',
    description:
      'Run a 3-layer ReAct bug investigation on a Jira ticket — traces git log, feature flags, dep bumps, call graph, code changes into a confidence-scored root-cause report. Call only when you have a concrete Jira key and need root-cause analysis; do NOT call for general questions about a ticket (use wi_jira_analyze).',
    category: 'auto',
    // ADR-039 AC-5 — execute-phase: dispatches a full investigation subagent, not a scope probe.
    phase: 'execute',
    posture_eligibility: ['bug-investigate', 'generic'],
    estimated_duration_ms: 25000,
    input_schema: {
      type: 'object',
      properties: {
        jira_key: { type: 'string', description: 'e.g. JIRA-15702', pattern: '^[A-Z][A-Z0-9_]+-\\d+$' },
      },
      required: ['jira_key'],
    },
    handler: async (input, ctx) => {
      // ADR-040 commit 3 canary: replace STUB('wi-investigate') with a
      // real dispatch through runSkillSubagent. When the Claude CLI is
      // unavailable, dispatch still writes an audit row with
      // status='failed' + error_text — AC-S4a passes on row existence,
      // not on skill success.
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      const jiraKey = typeof input.jira_key === 'string' ? input.jira_key : '';
      return runSkillSubagent(
        'wi-investigate',
        { goal: `Investigate ${jiraKey}`, jira_key: jiraKey },
        { db: ctx.db, sessionId: ctx.session_id },
      );
    },
  },
  {
    name: 'wi_pr_review',
    description:
      'AI-assisted PR review enriched with linked Jira tickets, past similar-change patterns, ownership map, and risk flags. Call when reviewing a specific PR number; do NOT call for general "what changed lately" questions (use wi_search instead).',
    category: 'auto',
    // ADR-039 AC-5 — execute-phase: enrich/analyze a PR, not a scope probe.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'generic'],
    estimated_duration_ms: 8000,
    input_schema: {
      type: 'object',
      properties: {
        pr: { type: 'integer', minimum: 1, description: 'PR number' },
        repo: { type: 'string', enum: REPO_ENUM, default: DEFAULT_REPO },
      },
      required: ['pr'],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-pr-review', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_blast_radius',
    description:
      'Compute blast radius for a file change — direct and transitive dependents, affected tests, and a risk score. Call before proposing edits to a shared module or when sizing a PR; do NOT call for files you already know are leaf-level utilities.',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'generic'],
    estimated_duration_ms: 2000,
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'repo-relative file path' },
        repo: { type: 'string', enum: REPO_ENUM, default: DEFAULT_REPO },
      },
      required: ['file'],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-blast-radius', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    // T5 (AC-6): flushes Claude Code session into WI's 4 memory surfaces.
    parallelizable: false,
    name: 'wi_update_context',
    description:
      'Flush the current Claude Code session into Work Intelligence — investigations, decisions, bugs, code edits — to all four memory surfaces. Call at the end of any non-trivial session; do NOT call mid-task or for trivial doc tweaks.',
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 4000,
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'optional topic / scope hint' },
        note: { type: 'string', description: 'optional summary note' },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-update-context', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_bug_resolve',
    description:
      'Mark a single WI bug as resolved or wont-fix by its numeric ID. Call when a captured bug has been fixed (commit landed) or explicitly declined; do NOT call without a verified ID.',
    category: 'auto',
    // D5 — tier 2: mutates bug status; reversible by flipping status back.
    risk_tier: 2,
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    // T5 (AC-6): mutates bugs row — single-writer required.
    parallelizable: false,
    posture_eligibility: ['bug-investigate', 'generic'],
    estimated_duration_ms: 500,
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'bugs.id' },
      },
      required: ['id'],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-bug-resolve', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_bug_resolve_all',
    description:
      'Trigger the BugResolverAgent on every matching proposed bug to attempt actual resolution. Call when the investigator has produced patches that need to be applied in bulk; do NOT call as a substitute for reviewing individual investigations.',
    category: 'auto',
    // D5 — tier 3: runs the BugResolverAgent which APPLIES PATCHES +
    // COMMITS to WI's own source. Colleague-visible via git history;
    // ALWAYS asks, ledger ignored.
    risk_tier: 3,
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    // T5 (AC-6): applies patches + commits — single-writer required.
    parallelizable: false,
    posture_eligibility: ['bug-investigate', 'generic'],
    estimated_duration_ms: 30000,
    input_schema: {
      type: 'object',
      properties: {
        max_matches: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-bug-resolve-all', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    // T5 (AC-6): full sync pipeline — heavy writes across all data sources.
    parallelizable: false,
    name: 'wi_sync',
    description:
      'Trigger a full background sync of Jira, Teams, Email, and GitHub and report what changed. Call when the user reports staleness or before a planning session; do NOT call repeatedly — sync is expensive and runs on a cron.',
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['generic'],
    estimated_duration_ms: 60000,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-sync', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_jira_analyze',
    description:
      'Run the 5-parallel AI analysis pipeline on a Jira ticket — classify, effort, plain-English explanation, solution proposal, code impact. Call to deeply understand one ticket before investigating; do NOT call when you only need a status read (use wi_search instead).',
    category: 'auto',
    // ADR-039 AC-5 — execute-phase: 5-parallel LLM analysis pipeline, not a scope probe.
    phase: 'execute',
    posture_eligibility: ['pm', 'bug-investigate', 'generic'],
    estimated_duration_ms: 12000,
    input_schema: {
      type: 'object',
      properties: {
        jira_key: { type: 'string', pattern: '^[A-Z][A-Z0-9_]+-\\d+$' },
      },
      required: ['jira_key'],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-jira-analyze', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_pre_meeting',
    description:
      'Generate pre-meeting context — attendees with recent activity, past meetings with this group, open action items, linked Jira tickets. Call before joining a meeting; do NOT call for ad-hoc 1:1s already in the morning brief.',
    category: 'auto',
    // ADR-039 AC-5 — execute-phase: heavyweight aggregate, not a read-only scope probe.
    phase: 'execute',
    posture_eligibility: ['pm', 'generic'],
    estimated_duration_ms: 5000,
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'optional calendar event id' },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-pre-meeting', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_morning_brief',
    description:
      'Generate the morning briefing — calendar with pre-meeting context, open Jiras, overnight Teams activity, open action items. Call once per day at session start; do NOT call repeatedly during a session.',
    category: 'auto',
    // ADR-039 AC-5 — execute-phase: heavyweight aggregate, not a read-only scope probe.
    phase: 'execute',
    posture_eligibility: ['pm', 'generic'],
    estimated_duration_ms: 6000,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-morning-brief', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_action_items',
    description:
      'List open action items across Jira, Teams, and Email. Call when the user asks "what do I owe" or planning the day; do NOT call as a search substitute when the user has a specific topic in mind (use wi_search).',
    category: 'auto',
    posture_eligibility: ['pm', 'generic'],
    estimated_duration_ms: 1500,
    input_schema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'optional — defaults to dispatcher user' },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-action-items', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    // T5 (AC-6): writes/upserts a bugs row with idempotent fingerprint.
    parallelizable: false,
    name: 'wi_bug_report',
    description:
      'Capture a bug into the WI bugs table with idempotent fingerprinting (same payload increments occurrence_count). Call when the user describes a bug that should be tracked; do NOT call for one-off issues already filed in Jira.',
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['bug-investigate', 'generic'],
    estimated_duration_ms: 1000,
    input_schema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: 'stable bug fingerprint (sha256 hint)' },
        signature: { type: 'string', description: 'short human-readable signature' },
      },
      required: ['signature'],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-bug-report', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_search_all',
    description:
      'Cross-source search: returns the local FTS result across Jira/Teams/Email/GitHub immediately, and kicks a live Outlook+Jira scrape in the background to freshen the cache for next time (local-first — fast, no 60s+ stall). For a fast scoped local read only, use wi_search.',
    category: 'auto',
    // ADR-039 AC-5 — execute-phase: this is the EXPLICIT browser-fetch tool (CQRS split —
    // reads are local-only via wi_search / fts_search; wi_search_all scrapes Outlook + Jira
    // live). Must NOT be reachable during read-only scope refinement.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    // tsk_445432091927 — local-first returns in <1s; the live scrape is detached.
    estimated_duration_ms: 3000,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    handler: async (input, ctx) => {
      // Local-first (tsk_445432091927): searchAll returns the local FTS result
      // immediately and detaches the live Outlook+Jira scrape to warm the cache
      // for the next call. Uncapped maxResults so the local read is exhaustive.
      // This is the deep counterpart to wi_search's fast scoped read.
      const query = String(input.query ?? '').trim();
      if (!query) return { error: 'query is required' };
      const { searchAll } = await import('../../tools/search-all.js');
      const { getBrowserSession } = await import('../../fetcher/sources/browser-session.js');
      return searchAll(
        ctx.db,
        {
          query,
          sources: ['email', 'jira', 'teams'],
          maxResults: Number.MAX_SAFE_INTEGER, // no cap — fetch + extract everything
          // tsk_445432091927 — EXECUTE-phase dispatches were stalling 60-138s on
          // the sequential Outlook(≤90s)+Jira(≤300s) live scrape. Return the local
          // FTS result now (<1s) and warm the cache in the background instead, so
          // a single /wi dispatch stays inside the p95<15s budget.
          mode: 'local-first',
        },
        getBrowserSession(),
        process.env.ANTHROPIC_API_KEY || undefined,
      );
    },
  },
  {
    name: 'wi_teams_search',
    description:
      'FTS5 search across Teams messages and meeting transcripts, ranked and grouped by chat with missing-transcript alerts. Call when the user references a Teams conversation by topic; do NOT call when the user has a Jira key (use wi_jira_analyze).',
    category: 'auto',
    posture_eligibility: ['pm', 'bug-investigate', 'generic'],
    estimated_duration_ms: 1500,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-teams-search', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_daily_digest',
    description:
      'Get the AI-generated daily activity digest for a topic — key events, decisions, open items in the last 24h. Call when the user asks for a topic update; do NOT call without a topic argument.',
    category: 'auto',
    posture_eligibility: ['pm', 'generic'],
    estimated_duration_ms: 3000,
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
      },
      required: ['topic'],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-daily-digest', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    name: 'wi_check_links',
    description:
      'Validate [[wikilinks]] across the WI auto-memory directory and report unresolved refs. Read-only — never writes. Call when memory drift is suspected; do NOT call as part of normal task flow.',
    category: 'auto',
    posture_eligibility: ['generic'],
    estimated_duration_ms: 2000,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-check-links', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    // T5 (AC-6): re-runs install scripts that modify filesystem state.
    parallelizable: false,
    name: 'wi_skill_install',
    description:
      'Install or re-verify the WI skill catalog into the user Claude Code skill directory (idempotent symlink wiring). Call after a fresh clone or when slash commands 404; do NOT call during normal task work.',
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['generic'],
    estimated_duration_ms: 3000,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-skill-install', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },
  {
    // T5 (AC-6): writes to Jira (colleague-visible) — single-writer required.
    parallelizable: false,
    name: 'wi_save_to_ticket',
    description:
      'Append investigation findings or session notes to a Jira ticket investigation_notes field. Call when the user says "save this to ticket"; do NOT call without explicit user intent — this writes to Jira and is visible to the team.',
    category: 'confirm',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['bug-investigate', 'generic'],
    estimated_duration_ms: 2000,
    input_schema: {
      type: 'object',
      properties: {
        jira_key: { type: 'string', pattern: '^[A-Z][A-Z0-9_]+-\\d+$' },
        note: { type: 'string', description: 'markdown content to append' },
      },
      required: ['jira_key', 'note'],
    },
    handler: async (input, ctx) => {
      const { runSkillSubagent } = await import('./skill-dispatch.js');
      return runSkillSubagent('wi-save-to-ticket', input as unknown as import('./skill-dispatch.js').SkillDispatchArgs, {
        db: ctx.db,
        sessionId: ctx.session_id,
      });
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-038 v2.5 D3 slice 3 — cypher_project_* (project CRUD)
  //
  // Two tools that expose the projects table introduced by v76 + v77:
  //   cypher_project_create — register a new project slug
  //   cypher_project_list   — enumerate known projects
  //
  // Projects are the scope-hierarchy peer above tasks. cypher_task_create
  // requires project to exist (slice 2 FK), so the model needs these
  // tools to bootstrap a new project before opening tasks against it.
  //
  // Both are `category: 'auto'` — purely local SQLite reads/writes.
  // Eligible across all postures.
  // ─────────────────────────────────────────────────────────────────────────
  {
    // T5 (AC-6): INSERTs a projects row; idempotent but single-writer.
    parallelizable: false,
    name: 'cypher_project_create',
    description:
      "Register a new project so tasks can be opened under it. Idempotent — calling twice with the same id returns the existing row unchanged. Use BEFORE cypher_task_create when the desired project isn't already in cypher_project_list output. Slug should be short, lowercase, kebab-case (e.g. 'app', 'ops', 'my-service').",
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project slug — short, lowercase, kebab-case identifier. Becomes the FK target for tasks.project.',
          maxLength: 64,
        },
        name: {
          type: 'string',
          description: 'Human-readable name (e.g. "Application", "Operations")',
          maxLength: 120,
        },
        description: {
          type: 'string',
          description: 'Optional one-line description of what this project covers',
          maxLength: 240,
        },
        default_branch: {
          type: 'string',
          description: "Optional default git branch name (e.g. 'main', 'master', 'develop')",
          maxLength: 64,
        },
        repo_path: {
          type: 'string',
          description: 'Optional path to the project repo on disk (e.g. "./repos/app"). D4 worktree work fills this in.',
          maxLength: 240,
        },
      },
      required: ['id', 'name'],
    },
    handler: async (input, ctx) => {
      const id = String(input.id ?? '').slice(0, 64);
      const name = String(input.name ?? '').slice(0, 120);
      if (!id || !name) {
        return { error: 'missing_required_fields', hint: 'id and name are required' };
      }
      try {
        const project = createProject(ctx.db, {
          id,
          name,
          description: input.description != null ? String(input.description).slice(0, 240) : undefined,
          default_branch: input.default_branch != null ? String(input.default_branch).slice(0, 64) : undefined,
          repo_path: input.repo_path != null ? String(input.repo_path).slice(0, 240) : undefined,
        });
        return {
          id: project.id,
          name: project.name,
          description: project.description,
          default_branch: project.default_branch,
          repo_path: project.repo_path,
          created_at: project.created_at,
        };
      } catch (err) {
        return { error: 'create_failed', message: (err as Error).message };
      }
    },
  },
  {
    name: 'cypher_project_list',
    description:
      'List all known projects. Call this FIRST when uncertain whether a project slug exists before cypher_task_create or cypher_project_create. Returns id, name, description, default_branch, repo_path for each project ordered by id ASC. Cheap — single SQLite read.',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_input, ctx) => {
      return listProjects(ctx.db).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        default_branch: p.default_branch,
        repo_path: p.repo_path,
      }));
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-038 v2.5 D2 — cypher_task_* (task memory CRUD)
  //
  // Four tools that expose the D2 task-memory substrate to the loop:
  //   cypher_task_create     — open a new persistent task
  //   cypher_task_list       — enumerate open tasks (by project/status)
  //   cypher_task_close      — close a task with a reason
  //   cypher_task_show_context — read curator-distilled context for a task
  //
  // All four are `category: 'auto'` — they read/write the local SQLite DB
  // only; no network calls, no LLM usage. Eligible across all postures.
  // ─────────────────────────────────────────────────────────────────────────
  {
    // T5 (AC-6): INSERTs a tasks row.
    parallelizable: false,
    name: 'cypher_task_create',
    description:
      'Create a new persistent task that survives bridge restarts and spans multiple dispatches. Use when starting a multi-dispatch work unit (PR review, bug investigation, feature build) that needs accumulated context. Returns the new task_id — store it and pass to future dispatches as task_id.',
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title describing the work unit (1–120 chars)',
          maxLength: 120,
        },
        posture: {
          type: 'string',
          enum: ['pr_review', 'bug_investigate', 'pm', 'generic'],
          description: "Task posture — should match the dispatch's posture",
        },
        external_ref: {
          type: 'string',
          description: 'Optional Jira key or PR number (e.g. "JIRA-15702", "PR#4450")',
        },
        project: {
          type: 'string',
          description: 'Optional project name. Defaults to "wi".',
        },
      },
      required: ['title', 'posture'],
    },
    handler: async (input, ctx) => {
      const title = String(input.title ?? '').slice(0, 120);
      const posture = String(input.posture ?? 'generic') as import('./task-memory.js').TaskPosture;
      const external_ref = input.external_ref != null ? String(input.external_ref) : undefined;
      const project = input.project != null ? String(input.project) : undefined;
      try {
        const task = createTask(ctx.db, {
          title,
          posture,
          external_ref,
          project,
          owner_user_id: ctx.user,
        });
        return {
          task_id: task.id,
          title: task.title,
          posture: task.posture,
          status: task.status,
          external_ref: task.external_ref,
          project: task.project,
          created_at: task.created_at,
        };
      } catch (err) {
        // D3 slice 2 (v77): project validation can throw. Surface as a
        // structured tool_result so the model can recover (e.g. by
        // calling cypher_task_list to see valid projects) rather than
        // crash-stopping the loop.
        return {
          error: 'invalid_project_or_create_failed',
          message: (err as Error).message,
          hint: "Pass an existing project slug like 'wi' or a configured repo name, or omit the project field to default to 'wi'.",
        };
      }
    },
  },
  {
    name: 'cypher_task_list',
    description:
      "List open (or filtered) tasks. Call to find an existing task_id for a goal before creating a new one — avoids duplicate tasks. Returns task ids, titles, postures, dispatch counts, and last_touched timestamps. Defaults to scope='project' with project='wi' (single-project view). Pass scope='all_projects' for the cross-project view — the loop should opt in deliberately, not by accident.",
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['project', 'all_projects'],
          description: "Scope of the listing. 'project' (default) filters by the project field; 'all_projects' bypasses the filter entirely. The default-isolated behaviour matches ADR-038 § D3 — cross-project view is opt-in only.",
          default: 'project',
        },
        project: {
          type: 'string',
          description: "Project filter. Defaults to 'wi'. Ignored when scope='all_projects'.",
        },
        status: {
          type: 'string',
          enum: ['open', 'paused', 'blocked', 'closed'],
          description: "Status filter. Omit to get all statuses.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 20,
        },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      const scope = input.scope === 'all_projects' ? 'all_projects' : 'project';
      const project = scope === 'all_projects'
        ? undefined
        : (input.project != null ? String(input.project) : 'wi');
      const status = input.status != null
        ? (String(input.status) as import('./task-memory.js').TaskStatus)
        : undefined;
      const limit = typeof input.limit === 'number' ? Math.min(input.limit, 50) : 20;
      const tasks = listTasks(ctx.db, { project, status }).slice(0, limit);
      return tasks.map(t => ({
        task_id: t.id,
        title: t.title,
        posture: t.posture,
        status: t.status,
        project: t.project,
        external_ref: t.external_ref,
        last_touched: t.last_touched,
        closed_at: t.closed_at,
      }));
    },
  },
  {
    // T5 (AC-6): UPDATEs tasks.status / closed_at.
    parallelizable: false,
    name: 'cypher_task_close',
    description:
      "Close a task when the work is done or abandoned. Sets status='closed' and records a reason. Call this at the end of the final dispatch for a task — never mid-work. Returns the updated task.",
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'tsk_* task id to close',
        },
        reason: {
          type: 'string',
          description: "Short reason: 'shipped', 'wont-fix', 'duplicate', etc.",
        },
      },
      required: ['task_id'],
    },
    handler: async (input, ctx) => {
      const task_id = String(input.task_id ?? '');
      const reason = input.reason != null ? String(input.reason).slice(0, 240) : undefined;
      const existing = getTask(ctx.db, task_id);
      if (!existing) return { error: 'task_not_found', task_id };
      closeTask(ctx.db, task_id, reason);
      const updated = getTask(ctx.db, task_id);
      return {
        task_id: updated!.id,
        status: updated!.status,
        closed_at: updated!.closed_at,
        closed_reason: updated!.closed_reason,
      };
    },
  },
  {
    name: 'cypher_task_show_context',
    description:
      'Read the curator-distilled context for a task: summary, open_questions, things_tried, dispatch count. Call at the start of a dispatch when task_id is known but you need the full accumulated context text for reasoning. Cheaper than re-scanning dispatch history.',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'tsk_* task id',
        },
      },
      required: ['task_id'],
    },
    handler: async (input, ctx) => {
      const task_id = String(input.task_id ?? '');
      const block = loadTaskContext(ctx.db, task_id);
      if (!block) {
        const task = getTask(ctx.db, task_id);
        if (!task) return { error: 'task_not_found', task_id };
        return { error: 'task_not_open', task_id, status: task.status };
      }
      return {
        rendered: renderTaskContextBlock(block),
        task_id: block.task.id,
        title: block.task.title,
        posture: block.task.posture,
        dispatch_count: block.dispatch_count,
        context_version: block.context?.version ?? null,
        has_open_questions: !!block.context?.open_questions,
        has_things_tried: !!block.context?.things_tried,
      };
    },
  },
  {
    // T5 (AC-6): UPDATEs tasks.recurate_pending flag.
    parallelizable: false,
    name: 'cypher_task_recurate',
    description:
      "Flag a task's context for re-curation on the next dispatch. Use when the existing context is from an older curator format (rendered block shows '[note] curator format vN < current vM') OR when you suspect the context has drifted from reality. The next dispatch's curator runs unconditionally and replaces the latest context_summary / open_questions / things_tried. Idempotent — repeat calls before the next dispatch just bump the timestamp.",
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'tsk_* task id to flag for re-curation',
        },
      },
      required: ['task_id'],
    },
    handler: async (input, ctx) => {
      const task_id = String(input.task_id ?? '');
      const task = getTask(ctx.db, task_id);
      if (!task) return { error: 'task_not_found', task_id };
      const flagged = recurateTaskContext(ctx.db, task_id);
      return {
        task_id,
        recurate_pending: flagged,
        recommendation: flagged
          ? 'Next dispatch close will re-curate this task; until then the existing context is still used.'
          : 'Task lookup failed unexpectedly — no rows updated.',
      };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-038 v2.5 D5 — cypher_grant_* (permissions ledger tools)
  //
  // Three tools that let the loop persist user approvals so the same
  // question doesn't get asked every dispatch. Reads + writes the v82
  // permissions table.
  //
  // **Tier-3 safety floor:** cypher_grant_create REFUSES to write a
  // grant for an action_pattern that matches any tier-3 tool. The
  // loop's confirm-gate (slice 2+ — not in this slice) consults the
  // ledger before asking, but the gate itself enforces the tier-3
  // skip independently. Defense-in-depth.
  //
  // All three are `category: 'auto'` — purely local SQLite. Eligible
  // across all postures.
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'cypher_grant_create',
    description:
      "Persist a permission grant so subsequent matching tool calls skip the confirm prompt. Use AFTER the user has said yes — e.g. 'yes, and you can do this for the rest of this session' → scope_kind='session'. Refuses to grant tier-3 actions (irreversible / colleague-visible); those always ask. action_pattern supports a single trailing '*' wildcard.",
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    risk_tier: 1,
    // T5 (AC-6): INSERTs a permissions row.
    parallelizable: false,
    input_schema: {
      type: 'object',
      properties: {
        action_pattern: {
          type: 'string',
          description: "Action pattern (e.g. 'file.edit:*', 'smoke.run:bridge', 'cypher_task_create')",
          maxLength: 240,
        },
        scope_kind: {
          type: 'string',
          enum: ['one_shot', 'task', 'project', 'session', 'standing'],
          description: 'Lifecycle binding for the grant.',
        },
        scope_id: {
          type: 'string',
          description: "For 'task' grants pass the tsk_* id; for 'project' the project slug; for 'session' the cyp_* id. Omit for 'one_shot' and 'standing'.",
        },
        expires_at: {
          type: 'integer',
          description: 'Optional epoch-ms expiration. Combines with expires_after_n via AND.',
        },
        expires_after_n: {
          type: 'integer',
          description: 'Optional max-uses cap. Combines with expires_at via AND.',
        },
        reason: {
          type: 'string',
          description: "Free-text reason for audit (e.g. 'auto-approved smoke runs for D5 build').",
          maxLength: 240,
        },
      },
      required: ['action_pattern', 'scope_kind'],
    },
    handler: async (input, ctx) => {
      const { grantPermission } = await import('./permissions.js');
      const action_pattern = String(input.action_pattern ?? '');
      const scope_kind = String(input.scope_kind ?? 'one_shot') as import('./permissions.js').PermissionScopeKind;
      if (!action_pattern) return { error: 'missing_required_fields', hint: 'action_pattern is required' };

      // Tier-3 short-circuit. Find any tool in the catalog whose name
      // matches the pattern; if any is tier 3, refuse.
      const matchingTools = TOOL_CATALOG.filter(t => {
        const pat = action_pattern.endsWith('*')
          ? action_pattern.slice(0, -1)
          : action_pattern;
        return t.name === action_pattern || t.name.startsWith(pat);
      });
      const tier3Hit = matchingTools.find(t => effectiveRiskTier(t) === 3);
      if (tier3Hit) {
        return {
          error: 'tier_3_not_grantable',
          tool_name: tier3Hit.name,
          hint: 'Tier-3 tools (irreversible / colleague-visible) always ask; ledger ignored. No grant created.',
        };
      }

      try {
        const p = grantPermission(ctx.db, {
          action_pattern,
          scope_kind,
          scope_id: input.scope_id != null ? String(input.scope_id) : undefined,
          expires_at: typeof input.expires_at === 'number' ? input.expires_at : undefined,
          expires_after_n: typeof input.expires_after_n === 'number' ? input.expires_after_n : undefined,
          reason: input.reason != null ? String(input.reason).slice(0, 240) : undefined,
          granted_by: ctx.user,
        });
        return {
          id: p.id,
          action_pattern: p.action_pattern,
          scope_kind: p.scope_kind,
          scope_id: p.scope_id,
          status: p.status,
        };
      } catch (err) {
        return { error: 'grant_failed', message: (err as Error).message };
      }
    },
  },
  {
    name: 'cypher_grant_list',
    description:
      "List existing permission grants. Use to check whether a similar grant already exists before issuing a new one. Filter by status (defaults to all). Returns id, action_pattern, scope, status, uses_count for each grant.",
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    risk_tier: 1,
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'expired', 'revoked', 'consumed'],
          description: "Filter by status. Omit for all.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
        },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      const { listPermissions } = await import('./permissions.js');
      const status = input.status != null
        ? (String(input.status) as import('./permissions.js').PermissionStatus)
        : undefined;
      const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20;
      const grants = listPermissions(ctx.db, { status }).slice(0, limit);
      return grants.map(g => ({
        id: g.id,
        action_pattern: g.action_pattern,
        scope_kind: g.scope_kind,
        scope_id: g.scope_id,
        status: g.status,
        uses_count: g.uses_count,
        expires_at: g.expires_at,
        expires_after_n: g.expires_after_n,
        granted_at: g.granted_at,
        reason: g.reason,
      }));
    },
  },
  {
    name: 'cypher_grant_revoke',
    description:
      "Revoke an active permission grant by id. Use when the user wants to take back a previously-issued approval or when a grant has outlived its usefulness. Returns whether the grant was actually revoked (false when not found or already inactive).",
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    risk_tier: 1,
    // T5 (AC-6): UPDATEs a permissions row to status='revoked'.
    parallelizable: false,
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'prm_* grant id from cypher_grant_list',
        },
        reason: {
          type: 'string',
          description: 'Short reason for the revocation (audit trail)',
          maxLength: 240,
        },
      },
      required: ['id'],
    },
    handler: async (input, ctx) => {
      const { revokePermission, getPermission } = await import('./permissions.js');
      const id = String(input.id ?? '');
      if (!id) return { error: 'missing_id' };
      const before = getPermission(ctx.db, id);
      if (!before) return { error: 'grant_not_found', id };
      const revoked = revokePermission(ctx.db, id, input.reason != null ? String(input.reason).slice(0, 240) : undefined);
      const after = getPermission(ctx.db, id);
      return {
        id,
        revoked,
        prior_status: before.status,
        status: after?.status ?? 'unknown',
      };
    },
  },
  {
    name: 'cypher_compact_context',
    description:
      "Fold older tool results into a single summary so the dispatch can continue when context fills up before the hard 200K cap. Pass the iteration range to compact (default: everything except the last 3 iterations). Returns the curator-distilled summary text — reference it in subsequent reasoning instead of re-quoting tool results. Use ONLY when you notice context is filling up; do NOT call as a routine optimization.",
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 4000,
    // D5 — tier 2: writes nothing locally but burns Haiku tokens.
    risk_tier: 2,
    // T5 (AC-6): one-shot Haiku call + the model is expected to
    // reference the returned summary as canonical — running it
    // alongside other tool_use blocks would race the message
    // semantics. Serialise.
    parallelizable: false,
    input_schema: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'Optional one-liner of what the summary should preserve (e.g. "Search proxy 403 thread"). Helps Haiku keep the right detail.',
          maxLength: 240,
        },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      // The tool body itself doesn't mutate the loop's messages array
      // (it would require passing messages into the handler context;
      // future slice). It DOES make a one-shot Haiku call to produce a
      // summary the model can reference. The model is responsible for
      // referring to the summary in its next iteration's reasoning.
      try {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const { bucketCallParams } = await import('../model-config.js');
        const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
        if (!apiKey) {
          return { error: 'no_api_key', hint: 'ANTHROPIC_API_KEY not set' };
        }
        const client = new Anthropic({
          apiKey,
          ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
        });
        const focus = input.focus != null ? String(input.focus).slice(0, 240) : '';
        const prompt = `You are a dispatch context summarizer. The Cypher loop is calling you because its message history is getting long.

Produce a concise summary (~500 tokens) of the dispatch so far that the loop can use as a stand-in for the older tool calls. The loop has access to the same dispatch history you don't — your job is to write a useful condensation.

${focus ? `FOCUS: ${focus}\n\n` : ''}Return ONLY the summary text — no preamble, no commentary, no JSON.`;
        const params = bucketCallParams(ctx.db, 'agents', 800);
        const response = await client.messages.create({
          ...params,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = response.content.find(b => b.type === 'text')?.text ?? '';
        return {
          summary: text.slice(0, 4000),
          instruction: 'Treat this summary as the canonical record of older tool calls. Reference it in subsequent reasoning instead of re-quoting individual results.',
        };
      } catch (err) {
        return { error: 'compact_failed', message: (err as Error).message };
      }
    },
  },
  {
    name: 'cypher_gc_run',
    description:
      "Run the GC retention sweep across cypher_steps (rollup → summary), cypher_sessions (weekly rollup), permission_uses (90d delete), dispatch_snapshots (closed + stale), gc_log trim. Pass dry_run=true to preview without mutating. Writes a row to gc_log on every call (dry_run too). Use sparingly — daemon wiring is a future slice; today this is on-demand.",
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 500,
    // D5 — tier 2: mutates the DB irreversibly when not dry_run. Worth
    // a moment's pause even though the actions are well-bounded.
    risk_tier: 2,
    // T5 (AC-6): GC sweeps + gc_log INSERT — single-writer required.
    parallelizable: false,
    input_schema: {
      type: 'object',
      properties: {
        dry_run: {
          type: 'boolean',
          description: 'Preview actions without mutating. Default false.',
          default: false,
        },
      },
      required: [],
    },
    handler: async (input, ctx) => {
      const { runGc } = await import('./gc.js');
      const dry_run = input.dry_run === true;
      const result = runGc(ctx.db, { dry_run });
      return {
        run_id: result.run_id,
        ran_at: result.ran_at,
        duration_ms: result.duration_ms,
        dry_run: result.dry_run,
        actions: result.actions,
        errors: result.errors,
        action_count: result.actions.length,
        total_rows_affected: result.actions.reduce((s, a) => s + a.rows_affected, 0),
      };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Loop infrastructure — smoke_run, typecheck_run, clarify, cypher_record_outcome
  //
  // Phase 2 ships catalog entries with real input_schemas and STUB-shape
  // handler returns that signal `deferred: 'phase-3'`. The real bodies land
  // in Phase 3 when the loop controller takes ownership of subprocess
  // sandboxing (smoke_run / typecheck_run), suspension semantics (clarify),
  // and outcome persistence (cypher_record_outcome).
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'smoke_run',
    description:
      'Run the npm run smoke:bridge suite (or a single section) to verify bridge behaviour. Call after non-trivial bridge/service/db changes before declaring done. Do NOT call for pure docs edits or read-only investigation — it costs ~30s and may make a live brain call.',
    category: 'confirm',
    // D5 — tier 2: spawns a subprocess but bounded + reversible (smoke
    // only reads + writes test fixtures, never customer state).
    risk_tier: 2,
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    // T5 (AC-6): spawns a subprocess + writes test fixtures.
    parallelizable: false,
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 60000,
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: 'optional smoke section number; omit to run all sections',
        },
        skip_brain_live: {
          type: 'boolean',
          default: true,
          description: 'when true, sets SKIP_BRAIN_LIVE_CALL=1 to avoid the live Claude call',
        },
      },
    },
    handler: async (input, _ctx) => {
      const section = typeof input.section === 'number' ? input.section : null;
      const skipBrainLive = input.skip_brain_live !== false;
      return {
        deferred: 'phase-3',
        section,
        skip_brain_live: skipBrainLive,
        recommendation: 'run smoke manually for now',
      };
    },
  },
  {
    name: 'typecheck_run',
    description:
      'Run npm run typecheck against the root (and optionally web/) TypeScript projects. Call after TS edits to catch type regressions before smoke. Do NOT call when only non-TS files changed — wasted CPU.',
    category: 'auto',
    // ADR-039 AC-5 — execute-phase: verify/build action (runs tsc subprocess), never planning.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 30000,
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['root', 'web', 'both'],
          default: 'root',
          description: 'which tsconfig to check',
        },
      },
    },
    handler: async (input, _ctx) => {
      const scopeRaw = String(input.scope ?? 'root');
      const scope = scopeRaw === 'web' || scopeRaw === 'both' ? scopeRaw : 'root';
      return {
        deferred: 'phase-3',
        scope,
        recommendation: 'run npm run typecheck manually',
      };
    },
  },
  {
    // T5 (AC-6): suspends the loop to surface a question — semantics
    // require it to run alone.
    parallelizable: false,
    name: 'clarify',
    description:
      'Pause the loop and surface a question to the user. Call when reasoning is genuinely blocked on missing information that the user alone can supply. Do NOT call for questions answerable from the catalog (palace, status, code-graph) — exhaust read tools first.',
    category: 'confirm',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 100,
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'the question to ask the user',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'optional multi-choice options; when present, render as a picker',
        },
      },
      required: ['question'],
    },
    handler: async (input, _ctx) => {
      const question = String(input.question ?? '').slice(0, 400);
      const options = Array.isArray(input.options)
        ? input.options.slice(0, 10).map((o) => String(o).slice(0, 240))
        : [];
      return {
        deferred: 'phase-3',
        status: 'queued',
        question,
        options,
        queued_at: new Date().toISOString(),
        recommendation: 'phase-3 loop controller suspends here',
      };
    },
  },
  {
    // T5 (AC-6): terminal outcome write — fundamentally single-writer
    // (multiple invocations would corrupt the Beta prior signal).
    parallelizable: false,
    name: 'cypher_record_outcome',
    description:
      'Write a cypher_outcomes row to close the loop with a verdict. Call exactly once at the end of a dispatch — the loop terminator. Do NOT call mid-loop or speculatively; outcomes update Beta priors and double-writes corrupt the learning signal.',
    category: 'auto',
    // ADR-039 AC-5 — mutator: scope-phase MUST NOT see this tool.
    phase: 'execute',
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 80,
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'cyp_* session id returned by the dispatcher',
        },
        outcome: {
          type: 'string',
          enum: ['success', 'mixed', 'failed', 'halted', 'abandoned', 'rejected_non_interactive'],
          description: 'verdict for the loop',
        },
        note: {
          type: 'string',
          description: 'optional human-readable note for the audit trail',
        },
      },
      required: ['session_id', 'outcome'],
    },
    handler: async (input, _ctx) => {
      const session_id = String(input.session_id ?? '');
      const outcome = String(input.outcome ?? '');
      const note = input.note != null ? String(input.note).slice(0, 400) : undefined;
      return {
        deferred: 'phase-3',
        session_id,
        outcome,
        note,
        recommendation: 'phase-3 loop controller writes the real row',
      };
    },
  },
  {
    // ADR-053 Phase 3 (Q7) — executor→PM feedback channel. Writes a
    // sub_task_events row mid-execution. PM does NOT stay alive; events
    // accumulate and PM reads unresolved rows on re-entry (pm-resume).
    // AC-S6: writes a row for a valid kind. AC-S7: execute-phase only,
    // NOT in scope-phase or architect-phase catalogs (write-tool discipline).
    parallelizable: false,
    name: 'emit_sub_task_event',
    description:
      'Emit a structured event to the PM tier during execution (ADR-053). Use when you hit a question, produce a partial result, hit a blocker, or discover the scope is wrong. The event is queued for the PM to resolve on re-entry — it does NOT pause your loop. Kinds: question | partial | blocker | scope_discovery.',
    category: 'auto',
    // Execute-phase only — the scope refiner and the architect reviewer
    // must NOT see this write tool.
    phase: 'execute',
    risk_tier: 1,
    posture_eligibility: ['pr-review', 'bug-investigate', 'pm', 'generic'],
    estimated_duration_ms: 50,
    input_schema: {
      type: 'object',
      properties: {
        sub_task_id: {
          type: 'string',
          description: 'The task id (tsk_*) this event pertains to',
        },
        kind: {
          type: 'string',
          enum: ['question', 'partial', 'blocker', 'scope_discovery'],
          description: 'Event kind',
        },
        payload: {
          type: 'object',
          description: 'Arbitrary JSON payload describing the event',
        },
      },
      required: ['sub_task_id', 'kind'],
    },
    handler: async (input, ctx) => {
      const sub_task_id = String(input.sub_task_id ?? '');
      const kind = String(input.kind ?? '');
      const payload_json = JSON.stringify(input.payload ?? {});
      const VALID = ['question', 'partial', 'blocker', 'scope_discovery'];
      if (!sub_task_id) {
        return { ok: false, error: 'sub_task_id is required' };
      }
      if (!VALID.includes(kind)) {
        return { ok: false, error: `invalid kind '${kind}'; expected one of ${VALID.join('|')}` };
      }
      try {
        const info = ctx.db
          .prepare(
            `INSERT INTO sub_task_events (sub_task_id, kind, payload_json) VALUES (?, ?, ?)`,
          )
          .run(sub_task_id, kind, payload_json);
        return { ok: true, id: Number(info.lastInsertRowid), sub_task_id, kind };
      } catch (err) {
        return { ok: false, error: `write_failed: ${(err as Error).message}` };
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Catalog hygiene helpers — single source of truth for Phase 3 + smoke
// ---------------------------------------------------------------------------

/**
 * Return the subset of the catalog that the loop should expose to the
 * model for a given posture. `'cli'`-category tools are always
 * excluded; remaining tools must list the requested posture in their
 * `posture_eligibility`.
 */
export function toolsForPosture(posture: Posture): ToolDefinition[] {
  return TOOL_CATALOG.filter(
    (t) => t.category !== 'cli' && t.posture_eligibility.includes(posture),
  );
}

/**
 * Count of catalog entries that opted out of any default-shape rule.
 * Phase 2 acceptance gate: target 0. v2.0 closes with this count
 * documented in the SUMMARY.
 */
export function codegenExemptCount(): number {
  return TOOL_CATALOG.filter((t) => t.codegen_exempt !== undefined).length;
}

/**
 * ADR-038 v2.5 D5 — effective risk tier for a tool definition.
 *
 * Reads `tool.risk_tier` when declared; defaults to **1 (reversible
 * local)** when omitted. This default applies because the bulk of
 * the existing catalog is read-only or local writes — and a default
 * of 3 would make every tool require a confirm prompt, which is
 * worse-than-status-quo. New tools that mutate customer state MUST
 * declare risk_tier: 3 explicitly.
 *
 * The loop's confirm-gate uses this:
 *   tier 1  → fire without ledger consult (no friction)
 *   tier 2  → ledger consult; ask if no match
 *   tier 3  → ALWAYS ask; ledger ignored entirely
 */
export function effectiveRiskTier(tool: ToolDefinition): 1 | 2 | 3 {
  return tool.risk_tier ?? 1;
}

/**
 * ADR-038 v2.5 D5 — is this tool grantable? Returns false for tier-3
 * tools (irreversible / colleague-visible), true for tier 1 + 2.
 *
 * Used at grant time: a /wi grant request for an action_pattern
 * matching a tier-3 tool is rejected. Used at runtime: the loop
 * skips the ledger consult for tier-3 even if a row exists (defensive
 * — the grant should never have been issued, but if it sneaks in via
 * direct SQL, the loop won't honor it).
 */
export function isToolGrantable(tool: ToolDefinition): boolean {
  return effectiveRiskTier(tool) < 3;
}

// ---------------------------------------------------------------------------
// ADR-039 AC-5 + AC-9 — phase-aware catalog accessors
// ---------------------------------------------------------------------------

/**
 * ADR-039 AC-5 — effective phase for a tool.
 *
 * Defaults to `'both'` when the tool omits the field. This default is
 * deliberate: read-only tools are the bulk of the catalog and don't
 * need to declare anything. Mutators MUST opt in to `'execute'`
 * explicitly so that adding a new write tool without thinking about
 * phase silently lands it as `'both'` — which the test
 * `tests/cypher/tool-catalog-phase.test.ts` catches against the
 * known-mutator allowlist before it ships.
 */
/**
 * Duration ceiling (ms) for an UNTAGGED tool to remain scope-visible.
 * A tool with no explicit `phase` whose `estimated_duration_ms` exceeds
 * this is treated as `'execute'` — kept OUT of the SCOPE (refiner) surface.
 *
 * Why this exists (2026-07-14): the SCOPE refiner is a cheap read-only
 * goal-sharpening pass with a ~60s wall-clock budget (loop.ts, gated by
 * CYPHER_SCOPE_MAX_WALLCLOCK_MS). Heavy ANALYZE/subagent tools
 * (`wi_investigate` 25s, `typecheck_run` 30s, `wi_jira_analyze` 12s, …)
 * default to `phase:'both'` and leaked into the refiner's callable tool
 * list. When the refiner picked one it did EXECUTE-class work inside the
 * planning phase, burned the whole budget, and halted at 60s
 * (bug_scope_phase_heavyweight_tool_leak). The refiner does not
 * malfunction — it correctly uses a tool it was wrongly offered.
 *
 * The threshold sits in the natural gap in the catalog's declared
 * durations (light/medium tools ≤3000ms; the 7 heavy tools ≥4000ms), so
 * `> 3000` cleanly separates them. This is a SAFETY NET, not the primary
 * control: an explicit `phase` on the tool always wins (see below), so a
 * genuinely-cheap tool that happens to declare a high duration can opt
 * back into scope with `phase:'both'`, and a fast tool that must stay out
 * of scope can pin `phase:'execute'`. The net only catches tools that
 * forgot to declare — which is exactly the failure mode that caused the
 * bug, and the one we don't want to have to remember to prevent for every
 * future heavy tool.
 */
export const SCOPE_UNTAGGED_MAX_DURATION_MS = 3000;

export function effectiveToolPhase(tool: ToolDefinition): ScopeOrExecutePhase {
  // Explicit phase is authoritative — full manual control is retained.
  if (tool.phase) return tool.phase;
  // Untagged: fall back to the duration safety net. Anything heavier than
  // the scope budget can absorb is execute-only; everything else stays
  // scope-visible ('both'), preserving the prior default for light tools.
  if ((tool.estimated_duration_ms ?? 0) > SCOPE_UNTAGGED_MAX_DURATION_MS) {
    return 'execute';
  }
  return 'both';
}

/**
 * ADR-039 AC-5 — return the subset of the catalog visible to a given
 * phase.
 *
 *   - `phase='scope'`   — read-only surface. Returns every tool whose
 *                         effective phase is `'scope'` or `'both'`.
 *                         **Excludes every `'execute'` tool.** This is
 *                         the registry-level enforcement point that
 *                         `.claude/rules/cypher-discipline.md` cites in
 *                         its AC-23 verification clause.
 *   - `phase='execute'` — full surface. Returns the entire catalog;
 *                         every tool may run in execute phase regardless
 *                         of its declared `phase` (scope-only tools, if
 *                         any are added later, are still callable from
 *                         the execute phase).
 *
 * `'cli'`-category tools are filtered out by the loop's `toolsForPosture`
 * downstream; this helper does NOT pre-filter on category so callers
 * can reason about the phase surface independent of category.
 */
export function getCatalogForPhase(phase: ScopeOrExecutePhase): ToolDefinition[] {
  if (phase === 'execute') return TOOL_CATALOG.slice();
  // phase === 'scope' (or, if a future caller passes 'both', treat as scope —
  // the strictest reading; better to over-filter than to leak a mutator).
  return TOOL_CATALOG.filter((t) => effectiveToolPhase(t) !== 'execute');
}

/**
 * ADR-039 AC-9 — produce a non-binding catalog hint for the refiner.
 *
 * The hint is a short string the scope-phase refiner appends to its
 * system prompt so the LLM has signal about which skills MIGHT be
 * relevant — without prescribing routing (AC-10).
 *
 * Implementation per the T1 spike's `DERIVE-FROM-DESCRIPTION`
 * recommendation (.planning/spikes/2026-06-26-catalog-signal-audit/REPORT.md):
 *
 *   - `task_classes` on disk is noise-dominated (64% singleton vocab,
 *     top tokens are boilerplate, `build-feature` over-injected onto
 *     54% of skills via SYNONYMS). Scoring against it amplifies noise.
 *   - `trigger_phrases` is 0% populated (scanner bug — see follow-ups
 *     listed in REPORT.md). Filter-by-trigger is a no-op today.
 *   - `description` is 94.4% populated and is the strongest signal.
 *
 * So we score skills against the raw goal text by counting
 * non-stopword token overlaps with each skill's `description`. The
 * top 5 hits become the hint. When the goal is empty / junk / has no
 * overlap, return an empty string and let the refiner work without a
 * hint. The hint is advisory; refiner is free to ignore it (AC-10).
 *
 * Note: `task_classes` is still queried and surfaced alongside the
 * matched skills so the refiner can see ADR-039 AC-9's literal phrase
 * `skill_catalog.task_classes filtered by trigger_phrases` honored in
 * spirit — but the scoring path is description-based per T1.
 */
export async function getCatalogHint(
  rawGoal: string,
  db: Database.Database,
): Promise<string> {
  const goal = (rawGoal ?? '').trim();
  if (!goal) return '';

  // ── Recognition path (v98): learned prompt→skill memory ──────────────────
  // Match the goal against embedded past goals, outcome-weighted. This is the
  // primary hint when Ollama is up AND prompt_memory has been backfilled.
  // Returns null → fall through to the description word-overlap fallback below
  // (Ollama down, empty memory, or nothing cleared the similarity gate).
  try {
    const { rankPromptMemory } = await import('../embedder.js');
    const ranked = await rankPromptMemory(goal, db);
    if (ranked && ranked.length > 0) {
      // Blend the semantic/outcome score with the skill's global Beta prior as
      // a confidence nudge: proven skills float up, burned skills sink, but a
      // relevant cold skill still surfaces (prior floor 0.5). Uses aggregate
      // priors across ALL task_classes — NOT getEffectivePriors(db,'*',…),
      // which filters on the literal '*' partition and returns 0.5 for nearly
      // every skill (audit BLOCKER-1, 2026-07-15). Read-only (learn.ts remains
      // sole skill_priors writer).
      let priorMean = new Map<string, number>();
      try {
        const { getAggregatePriorMeans } = await import('./learn.js');
        priorMean = getAggregatePriorMeans(db, ranked.map((r) => r.skill));
      } catch {
        // priors unavailable → treat every skill as neutral (0.5).
      }
      const blendedAll = ranked
        .map((r) => {
          const mean = priorMean.get(r.skill) ?? 0.5;
          return { ...r, blended: r.score * (0.5 + 0.5 * mean), mean };
        })
        .sort((a, b) => b.blended - a.blended || a.skill.localeCompare(b.skill));

      // Phase-0 M1 dispatchability filter (env-gated). When
      // STAGE1_DISPATCHABLE_ONLY=1, the hint corpus is narrowed to only the
      // skills the bridge can dispatch directly (get/post routes in
      // SKILL_ROUTES) — isolates the "corpus pollution" hypothesis. Default
      // off preserves current production behavior. See ADR-050 + BUILD-PLAN-01.
      const { DISPATCHABLE_SKILLS } = await import('./skill-dispatch.js');
      const FILTER_ON = process.env.STAGE1_DISPATCHABLE_ONLY === '1';
      const blended = (FILTER_ON
        ? blendedAll.filter((b) => DISPATCHABLE_SKILLS.has(b.skill))
        : blendedAll
      ).slice(0, 5);

      const lines = [
        'Candidate skills (learned from similar past prompts + success-rate — advisory, not binding):',
      ];
      for (const b of blended) {
        lines.push(
          `  - ${b.skill} (sim=${b.sim.toFixed(2)}, success=${b.mean.toFixed(2)}, matches=${b.matches})`,
        );
      }
      return lines.join('\n');
    }
  } catch {
    // Any failure in the recognition path → fall through to word-overlap.
  }

  return getCatalogHintWordOverlap(goal, db);
}

/**
 * Fallback recognition: description-token word-overlap. Used when the learned
 * prompt-memory path is unavailable (Ollama down, memory empty, or no match).
 * This is the pre-v98 getCatalogHint body, unchanged.
 *
 * Exported (2026-07-15, ADR-042 Stage 1) so `stage1.ts` can run it in
 * PARALLEL with the semantic path — the cascade in `getCatalogHint` is
 * "semantic OR overlap", which was the audit's HIGH-1 root cause. Stage 1
 * merges them explicitly with provenance.
 */
export function getCatalogHintWordOverlap(
  goal: string,
  db: Database.Database,
): string {
  // tokenizes descriptions, so overlap math is apples-to-apples. Inline
  // stopwords mirror skill-discovery.ts:60-69 (kept here to avoid an
  // import cycle with the discovery module).
  const STOPWORDS = new Set([
    'a','an','and','are','as','at','be','by','for','from','has','have','in',
    'is','it','of','on','or','that','the','this','to','was','with','when','who',
    'will','would','use','used','using','these','those','about','into','their',
    'them','they','than','then','thus','such','also','after','before','between',
    'across','over','under','any','each','every','all','one','two','three',
    'four','five','six','seven','eight','nine','how','what','why','where',
    'which','while','whose','whom',
  ]);
  const goalTokens = new Set(
    goal
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
  if (goalTokens.size === 0) return '';

  // Read the catalog. Defensive — the table may not exist (fresh DBs in
  // tests that skip the v63 migration); we degrade silently.
  let rows: Array<{
    skill_name: string;
    description: string | null;
    task_classes: string | null;
  }> = [];
  try {
    rows = db
      .prepare<[], { skill_name: string; description: string | null; task_classes: string | null }>(
        // Recognition-recall fix (ADR-042, 2026-07-25): scope to Cypher-
        // DISPATCHABLE skills only. skill_catalog holds 150 skills but only the
        // 55 wi-* ones are dispatchable by the loop (skill-autoregister.ts:84
        // scopes registration to wi-* prefix; SKILL_ROUTES only routes wi-*).
        // The other 95 (global engineering-skills pack senior-*/aws-*, claude-mem
        // plugins do/make-plan/remember/mem-search, misc playground/caveman-*)
        // are NOT routable — surfacing them in the hint crowds the correct wi-*
        // skill out of the top-5. Measured: filtering this lane to wi-* doubles
        // its paraphrase-corpus recall (2/10 → 4/10). See
        // .planning/audit-prompt-memory-recognition-FINDINGS.md.
        `SELECT skill_name, description, task_classes
           FROM skill_catalog
          WHERE description IS NOT NULL AND description != ''
            AND skill_name LIKE 'wi-%'`,
      )
      .all();
  } catch {
    return '';
  }

  // Phase-0 M1 dispatchability filter (env-gated). Same pattern as
  // getCatalogHint. Requires a synchronous import at module top; using
  // require() here would break ESM. Instead, DISPATCHABLE_SKILLS is imported
  // at file top-level below.
  if (process.env.STAGE1_DISPATCHABLE_ONLY === '1') {
    rows = rows.filter((r) => DISPATCHABLE_SKILLS_WORDPATH.has(r.skill_name));
  }

  if (rows.length === 0) return '';

  // Score each skill by counting goal-token overlaps in its description.
  const scored: Array<{ skill: string; score: number; tcs: string[] }> = [];
  for (const r of rows) {
    const desc = (r.description ?? '').toLowerCase();
    if (!desc) continue;
    let score = 0;
    for (const tok of goalTokens) {
      if (desc.includes(tok)) score += 1;
    }
    if (score === 0) continue;
    let tcs: string[] = [];
    if (r.task_classes) {
      try {
        const parsed = JSON.parse(r.task_classes);
        if (Array.isArray(parsed)) tcs = parsed.map((x) => String(x));
      } catch {
        // ignore malformed task_classes JSON
      }
    }
    scored.push({ skill: r.skill_name, score, tcs });
  }
  if (scored.length === 0) return '';

  scored.sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
  const top = scored.slice(0, 5);

  // Render. Concise, non-binding voice — the refiner is free to ignore.
  // The header line names the source so the LLM understands provenance.
  const lines = ['Candidate skills (description-overlap with raw goal — advisory, not binding):'];
  for (const t of top) {
    const tcSnippet = t.tcs.length > 0 ? ` [task_classes: ${t.tcs.slice(0, 4).join(', ')}]` : '';
    lines.push(`  - ${t.skill} (score=${t.score})${tcSnippet}`);
  }
  return lines.join('\n');
}

/**
 * ADR-050 R2-B.1 (option c — rerank) — trigger-phrase match set.
 *
 * Reads the backfilled `trigger_phrases` column from skill_catalog and
 * returns the set of skill names whose phrases appear in the goal. Used by
 * stage1.ts to RERANK (not filter, not boost) the merged candidate list:
 * a phrase-matched skill already inside the top-5 pool is swapped above
 * non-matching candidates, preserving relative order within each group.
 * Never adds skills that aren't already candidates.
 */
export function getTriggerPhraseHitSkills(
  goal: string,
  db: Database.Database,
): Set<string> {
  const hits = new Set<string>();
  const goalLower = (goal ?? '').toLowerCase();
  if (!goalLower) return hits;
  let rows: Array<{ skill_name: string; trigger_phrases: string | null }> = [];
  try {
    rows = db
      .prepare<[], { skill_name: string; trigger_phrases: string | null }>(
        `SELECT skill_name, trigger_phrases
           FROM skill_catalog
          WHERE skill_name LIKE 'wi-%'
            AND trigger_phrases IS NOT NULL
            AND trigger_phrases != ''
            AND trigger_phrases != '[]'`,
      )
      .all();
  } catch {
    return hits;
  }
  for (const r of rows) {
    let phrases: unknown;
    try {
      phrases = JSON.parse(r.trigger_phrases ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(phrases)) continue;
    for (const p of phrases) {
      if (typeof p !== 'string' || !p) continue;
      if (goalLower.includes(p.toLowerCase())) {
        hits.add(r.skill_name);
        break;
      }
    }
  }
  return hits;
}

/**
 * ADR-050 R2-B.1 (option c) — stable partition: phrase-matched skills rise
 * above non-matching ones, relative order preserved within each group.
 * Input `skill` names; returns same array reordered. Never adds/removes.
 */
export function rerankByPhraseHit(
  skills: Array<{ id: string; score: number }>,
  hits: Set<string>,
): Array<{ id: string; score: number }> {
  const matched: Array<{ id: string; score: number }> = [];
  const rest: Array<{ id: string; score: number }> = [];
  for (const c of skills) {
    (hits.has(c.id) ? matched : rest).push(c);
  }
  return [...matched, ...rest];
}

/**
 * ADR-039 T5 (AC-6) — effective parallelizability for a tool definition.
 *
 * Reads `tool.parallelizable` when declared; defaults to **true** when
 * omitted. This default applies because the bulk of the catalog is
 * read-only (palace_*, brain_recall, brain_context, code_graph_*, fts,
 * wi_* search/list tools). State mutators (DB writes, subprocess spawns,
 * external posts, fire-and-forget index locks) MUST declare
 * `parallelizable: false` explicitly so the loop runs them serially.
 *
 * The dispatcher in runLoop partitions the iteration's tool_use blocks
 * into a parallel batch (Promise.all) and a serial batch (awaited in
 * order), then concatenates the results back in the original tool_use
 * order before pushing to the message history.
 */
export function isToolParallelizable(tool: ToolDefinition): boolean {
  return tool.parallelizable !== false;
}
