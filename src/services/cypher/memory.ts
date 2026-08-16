/**
 * Cypher memory governance — Slice A (2026-06-13).
 *
 * Decides where each Cypher observation goes. The memory model in
 * `.planning/cypher/05-MEMORY-MODEL.md` lists three tiers:
 *
 *   1. **Palace** (cross-session, semantic-searchable) — for facts,
 *      decisions, patterns the next session should find via recall.
 *      Routed by wing: 'cypher_sessions' for engagement records,
 *      'decisions' for architectural choices, 'reviews' for code-
 *      review-shaped findings (touches ADR-032's reviews wing — same
 *      kind='lesson' contract).
 *   2. **claude-mem** (per-session timeline) — for the conversational
 *      record of what Cypher did this turn. Cheap to write, expensive
 *      to over-write — we keep this to milestone observations only,
 *      not every step.
 *   3. **Project memory** (`MEMORY.md` index + per-fact files in
 *      `~/.claude/projects/<repo>/memory/`) — for durable user-facing
 *      facts the next session's CLAUDE.md context needs. Highest-
 *      friction tier — Cypher writes here only on explicit confirm or
 *      on outcome=success of a session that produced new lessons.
 *
 * The 4th option is **transient** — drop it. Most Cypher steps are
 * transient (the investigate-budget probe, the ranked-skills lookup,
 * the path-classifier check). Only milestone-shaped observations
 * earn a write to one of the three persistent tiers.
 *
 * This module is the SOLE gateway for Cypher's persistent writes.
 * run.ts asks it `route(observation)` → MemoryDestination, then dispatches
 * the actual write. Callers MUST NOT write to palace / claude-mem /
 * project memory directly from inside Cypher's runtime — Hard rule 7.
 */

import type { PalaceClient } from '../../intelligence/palace-client.js';

// ---------------------------------------------------------------------------
// Observation shape
// ---------------------------------------------------------------------------

export type ObservationKind =
  | 'session_start'    // Cypher engagement opened
  | 'session_end'      // Cypher engagement closed (with outcome)
  | 'decision'         // architectural / strategic choice made during execution
  | 'lesson'           // pattern Cypher noticed worth remembering across sessions
  | 'fact'             // durable fact about the user, project, or environment
  | 'step_trace'       // 9-step contract transition — usually transient
  | 'tool_call';       // single tool invocation — transient unless surprising

export interface CypherObservation {
  kind: ObservationKind;
  /** Short human-readable summary — first line of the persisted entry. */
  title: string;
  /** Long-form content. May contain code, citations, links. */
  body: string;
  /** Outcome verdict at session_end. Optional otherwise. */
  outcome?: 'success' | 'mixed' | 'failed';
  /** Free-form tags; influence wing routing for palace. */
  tags?: string[];
  /** Originating session id (for joining back to cypher_sessions). */
  session_id: string;
}

export type MemoryTier = 'palace' | 'claude-mem' | 'project-memory' | 'transient';

export interface MemoryDestination {
  tier: MemoryTier;
  /** When tier='palace': which wing/room. */
  palace?: { wing: string; room: string };
  /** Why this tier was chosen — surfaced in audit logs and tests. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Routing — pure decision tree, no I/O
// ---------------------------------------------------------------------------

/**
 * Route an observation to the right tier. Pure: no DB, no FS, no MCP.
 * Caller does the actual write using the returned destination.
 *
 * Routing policy (from .planning/cypher/05-MEMORY-MODEL.md):
 *
 *   session_start → transient (we don't keep open-session noise)
 *   session_end + outcome=success → palace 'cypher_sessions/by-outcome'
 *                                  + claude-mem (one-line summary)
 *   session_end + outcome=mixed   → palace only
 *   session_end + outcome=failed  → palace + project-memory (so the
 *                                   next session can read what failed)
 *   decision                     → palace 'decisions/cypher'
 *   lesson                       → palace 'reviews/cypher-lessons'
 *                                  (uses ADR-032's reviews wing —
 *                                  same recall path)
 *   fact                         → project-memory (these are durable)
 *   step_trace                   → transient (cypher_steps table is
 *                                   the audit trail; palace would dilute)
 *   tool_call                    → transient unless tagged 'surprising'
 */
export function route(observation: CypherObservation): MemoryDestination {
  switch (observation.kind) {
    case 'session_start':
      return { tier: 'transient', reason: 'session-open noise; cypher_sessions row is the audit' };

    case 'session_end':
      if (observation.outcome === 'success') {
        return {
          tier: 'palace',
          palace: { wing: 'cypher_sessions', room: 'success' },
          reason: 'successful sessions are recall-worthy',
        };
      }
      if (observation.outcome === 'failed') {
        return {
          tier: 'project-memory',
          reason: 'failures get a project-memory entry so the next session sees the gotcha',
        };
      }
      return {
        tier: 'palace',
        palace: { wing: 'cypher_sessions', room: 'mixed' },
        reason: 'mixed outcomes are still recall-worthy but quieter',
      };

    case 'decision':
      return {
        tier: 'palace',
        palace: { wing: 'decisions', room: 'cypher' },
        reason: 'architectural/strategic decisions cross sessions',
      };

    case 'lesson':
      return {
        tier: 'palace',
        palace: { wing: 'reviews', room: 'cypher-lessons' },
        reason: 'lessons feed ADR-032 persona memory recall',
      };

    case 'fact':
      return {
        tier: 'project-memory',
        reason: 'facts are durable user/project context the next session reads',
      };

    case 'step_trace':
      return { tier: 'transient', reason: 'cypher_steps table is the audit trail' };

    case 'tool_call':
      if (observation.tags?.includes('surprising')) {
        return {
          tier: 'palace',
          palace: { wing: 'cypher_sessions', room: 'tool-surprises' },
          reason: 'surprising tool outcomes are worth recall',
        };
      }
      return { tier: 'transient', reason: 'routine tool call; not recall-worthy' };
  }
}

// ---------------------------------------------------------------------------
// Persistence — actually write the observation
// ---------------------------------------------------------------------------

export interface PersistOptions {
  palace?: PalaceClient | null;
  /** When false, persist() is a no-op. For testing + the kill-switched path. */
  enabled?: boolean;
}

export interface PersistResult {
  destination: MemoryDestination;
  wrote: boolean;
  error?: string;
}

/**
 * Route + write in one call. Best-effort: a palace failure is logged
 * and swallowed (Hard rule 6 — persistence never crashes Cypher).
 *
 * project-memory writes are NOT performed here — they require human
 * gating (per the locked spec, project-memory is the highest-friction
 * tier). Cypher's run.ts surfaces a "consider writing project memory"
 * card in the surface stage; the user decides.
 */
export async function persist(
  observation: CypherObservation,
  opts: PersistOptions = {},
): Promise<PersistResult> {
  const destination = route(observation);
  if (opts.enabled === false || destination.tier === 'transient') {
    return { destination, wrote: false };
  }
  if (destination.tier === 'project-memory') {
    // Surfaced to user; not auto-written.
    return { destination, wrote: false, error: undefined };
  }
  if (destination.tier === 'palace' && destination.palace && opts.palace) {
    try {
      const content = `# ${observation.title}\n\n${observation.body}`;
      await opts.palace.addDrawer(
        destination.palace.wing,
        destination.palace.room,
        content,
        `cypher-${observation.session_id}-${observation.kind}`,
      );
      return { destination, wrote: true };
    } catch (err) {
      return {
        destination,
        wrote: false,
        error: `palace.addDrawer failed: ${(err as Error).message}`,
      };
    }
  }
  // claude-mem writes happen via the MCP tool from outside Cypher's
  // runtime — this gateway just signals the intent.
  return { destination, wrote: false };
}
