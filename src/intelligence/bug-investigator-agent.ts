/**
 * BugInvestigatorAgent — ADR-030 Phase B (Plan 75-03).
 *
 * Always-on agent that polls the bugs table for new captures the bridge
 * + agents + web-UI write, gathers structured evidence, calls Anthropic
 * through the `bug-investigator` model-config bucket, and writes a
 * `bug_investigations` row. Status flips:
 *
 *   new → investigating → proposed   (success)
 *   new → investigating → new        (transient failure, attempts < 3)
 *   new → investigating → wont-fix   (failure with attempts >= 3)
 *
 * Recursion guard: agent self-throws are captured to the bugs table with
 * source='bug-investigator' (Phase A schema-level placeholder); the
 * polling SELECT excludes them next tick.
 *
 * Best-effort: agent never markAgentCrashes itself. captureBug failures
 * are swallowed; runDecision failures roll the row back to 'new' (or
 * 'wont-fix' once attempts >= 3).
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md § Phase B,
 *       .planning/phases/75-adr-030-phase-b-bug-investigator/PLAN.md § 75-03
 */

import type Database from 'better-sqlite3';
import type {
  BugRow,
  BugEvidence,
} from '../types/bugs.js';
import { gatherEvidence } from '../services/bugs/evidence.js';
import { captureBug } from '../routes/bugs.js';
import type { PalaceClient } from './palace-client.js';

// ── Decision shape (parsed from the brain call) ─────────────────────────────

export interface InvestigationDecision {
  root_cause: string;                          // one sentence
  files_to_change: string[];                   // 0 or more file paths
  lines_changed: number;                       // estimate
  confidence: number;                          // 0..1
  suggested_patch: string | null;              // unified diff or null
}

export type DecideFn = (args: {
  bug: BugRow;
  evidence: BugEvidence;
}) => Promise<InvestigationDecision>;

// ── Options ─────────────────────────────────────────────────────────────────

export interface BugInvestigatorOptions {
  db: Database.Database;
  palaceClient: PalaceClient | null;
  bridgeBaseUrl: string;
  /** Test override — defaults to a real Anthropic call via bucketCallParams. */
  decideFn?: DecideFn;
  /** Test override — defaults to gatherEvidence from the evidence library. */
  evidenceFn?: (bug: BugRow) => Promise<BugEvidence>;
  /** Per-hour cap. Defaults to 10. Read by the bridge from BUG_INVESTIGATOR_MAX_PER_HOUR. */
  maxPerHour?: number;
}

// ── Tick result ─────────────────────────────────────────────────────────────

export type TickSkipReason = 'no_candidate' | 'budget_exceeded' | 'disabled';

export interface TickResult {
  investigated: number;                        // 0 or 1 per tick
  skipped: TickSkipReason | null;
  bugId?: number;
  investigationId?: number;
  error?: string;
}

// ── Agent ───────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;

export class BugInvestigatorAgent {
  private db: Database.Database;
  private decideFn: DecideFn;
  private evidenceFn: (bug: BugRow) => Promise<BugEvidence>;
  private maxPerHour: number;
  private inFlight = false;

  constructor(opts: BugInvestigatorOptions) {
    this.db = opts.db;
    this.decideFn = opts.decideFn ?? defaultDecideFn(opts.db);
    this.evidenceFn = opts.evidenceFn ?? ((bug) => gatherEvidence({
      db: opts.db,
      bug,
      palaceClient: opts.palaceClient,
      bridgeBaseUrl: opts.bridgeBaseUrl,
    }));
    this.maxPerHour = opts.maxPerHour ?? (Number(process.env.BUG_INVESTIGATOR_MAX_PER_HOUR) || 10);
  }

  /**
   * Run one tick: pick a bug, gather evidence, call brain, write
   * investigation. Bounded so concurrent ticks (e.g. setInterval racing
   * itself if a tick takes longer than the interval) collapse to a no-op.
   */
  async tick(): Promise<TickResult> {
    if (process.env.BUG_INVESTIGATOR_ENABLED === '0') {
      return { investigated: 0, skipped: 'disabled' };
    }
    if (this.inFlight) {
      // Re-entrancy guard — return no_candidate so callers don't double-count.
      return { investigated: 0, skipped: 'no_candidate' };
    }
    this.inFlight = true;
    try {
      return await this.runOne();
    } finally {
      this.inFlight = false;
    }
  }

  private async runOne(): Promise<TickResult> {
    // 1. Pick the highest-priority candidate.
    const bug = this.pickCandidate();
    if (!bug) return { investigated: 0, skipped: 'no_candidate' };

    // 2. Brain budget check (per-hour cap on this bucket).
    if (this.budgetExceeded()) {
      return { investigated: 0, skipped: 'budget_exceeded' };
    }

    // 3. Atomically claim the row: bump attempts, flip to 'investigating'.
    //    Pre-incrementing attempts means a crash mid-tick still bounds retries.
    this.db
      .prepare(`UPDATE bugs SET status='investigating', investigation_attempts=investigation_attempts+1 WHERE id=?`)
      .run(bug.id);
    const attemptsAfter = bug.investigation_attempts + 1;

    try {
      const evidence = await this.evidenceFn(bug);
      const decision = await this.decideFn({ bug, evidence });
      const validated = validateDecision(decision);

      // 4. Write the investigation row + flip to 'proposed' atomically.
      const investigationId = this.persistInvestigation(bug, validated);

      process.stderr.write(
        `[BugInvestigator] picked=#${bug.id} fp=${bug.fingerprint} ` +
          `decided confidence=${validated.confidence.toFixed(2)} → proposed (inv=${investigationId})\n`,
      );

      return { investigated: 1, skipped: null, bugId: bug.id, investigationId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Self-capture this failure as a bug — the recursion-guard SELECT
      // filters source='bug-investigator' so we won't loop on it.
      try {
        captureBug(this.db, {
          source: 'bug-investigator',
          errorName: err instanceof Error ? err.name : 'BugInvestigatorError',
          message: errMsg,
          stack: (err instanceof Error && err.stack) ? err.stack : undefined,
          context: { bugId: bug.id, fingerprint: bug.fingerprint, attempt: attemptsAfter },
        });
      } catch {
        /* swallow secondary capture failures */
      }

      // 5. Roll back status. attempts already incremented; if at cap, give up.
      const nextStatus: 'wont-fix' | 'new' = attemptsAfter >= MAX_ATTEMPTS ? 'wont-fix' : 'new';
      this.db.prepare(`UPDATE bugs SET status=? WHERE id=?`).run(nextStatus, bug.id);

      process.stderr.write(
        `[BugInvestigator] failed #${bug.id} (attempt ${attemptsAfter}/${MAX_ATTEMPTS}) → ${nextStatus}: ${errMsg}\n`,
      );
      return { investigated: 0, skipped: null, bugId: bug.id, error: errMsg };
    }
  }

  /**
   * SELECT one candidate. Severity-first then recency. Recursion guard
   * (source != 'bug-investigator') and attempt cap (< 3) baked into the
   * WHERE clause.
   */
  private pickCandidate(): BugRow | null {
    return (
      this.db
        .prepare(
          `SELECT * FROM bugs
            WHERE status = 'new'
              AND source != 'bug-investigator'
              AND investigation_attempts < ?
            ORDER BY
              CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              last_seen_at DESC
            LIMIT 1`,
        )
        .get(MAX_ATTEMPTS) as BugRow | undefined
    ) ?? null;
  }

  /**
   * Per-hour cap on the 'bug-investigator' bucket. Queries the existing
   * brain_user_budget_ledger (Phase 72 v46 schema) for rows where
   * bucket='bug-investigator' AND day_iso=today, then sums calls if the
   * column is per-day. Phase B enforces the cap in code; we count direct
   * Anthropic calls via a per-process tally.
   */
  private budgetExceeded(): boolean {
    // The ledger is per-day; per-hour requires a separate counter. We use
    // a simple in-process ring of timestamps for the last hour. This is
    // adequate while the agent is single-process; clusters need to graduate
    // to a SQLite ledger here.
    pruneOldCallsLocked(this.callTimestamps, Date.now() - 3600_000);
    return this.callTimestamps.length >= this.maxPerHour;
  }

  private callTimestamps: number[] = [];

  private persistInvestigation(bug: BugRow, d: InvestigationDecision): number {
    const now = new Date().toISOString();
    let investigationId = -1;
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO bug_investigations
             (bug_id, root_cause, files_to_change, lines_changed, confidence, suggested_patch, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bug.id,
          d.root_cause,
          JSON.stringify(d.files_to_change),
          d.lines_changed,
          d.confidence,
          d.suggested_patch,
          now,
        );
      investigationId = Number(result.lastInsertRowid);
      this.db
        .prepare(`UPDATE bugs SET status='proposed', last_investigation_id=? WHERE id=?`)
        .run(investigationId, bug.id);
    })();
    this.callTimestamps.push(Date.now());
    return investigationId;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pruneOldCallsLocked(arr: number[], cutoff: number): void {
  while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
}

/**
 * Validates and normalizes the brain's output. Throws if essential fields
 * are missing — caller's catch arm rolls the row back.
 */
export function validateDecision(d: unknown): InvestigationDecision {
  if (!d || typeof d !== 'object') {
    throw new Error('decision: not an object');
  }
  const dd = d as Record<string, unknown>;
  if (typeof dd.root_cause !== 'string' || dd.root_cause.length === 0) {
    throw new Error('decision: root_cause missing or empty');
  }
  if (!Array.isArray(dd.files_to_change)) {
    throw new Error('decision: files_to_change must be an array');
  }
  if (!dd.files_to_change.every(f => typeof f === 'string')) {
    throw new Error('decision: files_to_change entries must be strings');
  }
  if (typeof dd.confidence !== 'number' || dd.confidence < 0 || dd.confidence > 1) {
    throw new Error('decision: confidence must be 0..1');
  }
  const linesRaw = (typeof dd.lines_changed === 'number' && Number.isFinite(dd.lines_changed))
    ? Math.max(0, Math.floor(dd.lines_changed))
    : 0;
  return {
    root_cause: dd.root_cause,
    files_to_change: dd.files_to_change as string[],
    lines_changed: linesRaw,
    confidence: dd.confidence,
    suggested_patch: typeof dd.suggested_patch === 'string' ? dd.suggested_patch : null,
  };
}

/**
 * Default decideFn — calls Anthropic via bucketCallParams('bug-investigator').
 * In Phase A we use a placeholder that throws "not yet wired" so the agent
 * is exercisable end-to-end via test override but doesn't burn budget on
 * a real Anthropic call until the bridge is configured to do so.
 *
 * Phase 75-04 wires this via the bridge boot block; tests inject their
 * own decideFn directly so this default is never exercised in CI.
 */
function defaultDecideFn(_db: Database.Database): DecideFn {
  return async () => {
    throw new Error(
      'BugInvestigatorAgent: default decideFn not wired — pass a decideFn in BugInvestigatorOptions, ' +
        'or use the bridge boot block path which constructs one from bucketCallParams(\'bug-investigator\').',
    );
  };
}

/**
 * Build a real decideFn that calls Anthropic via bucketCallParams.
 * Used by the bridge boot block (Plan 75-04). The `client` argument is
 * loosely typed to avoid pulling Anthropic SDK types into this module —
 * the bridge passes its existing AIAnalyzer-internal client.
 *
 * Returns a decideFn that runs a single tool_use call against the
 * 'bug-investigator' bucket; throws on any Anthropic error (caught by the
 * agent and rolled back).
 */
export function createBucketAwareDecideFn(
  client: AnthropicLike,
  db: Database.Database,
  bucketCallParams: (db: Database.Database, bucket: 'bug-investigator') => {
    model: string;
    max_tokens: number;
    output_config: { effort: string };
    thinking?: { type: 'adaptive' };
  },
): DecideFn {
  return async ({ bug, evidence }) => {
    const params = bucketCallParams(db, 'bug-investigator');

    const response = await client.beta.promptCaching.messages.create({
      ...params,
      system: [{
        type: 'text',
        text:
          'You are the BugInvestigatorAgent for Work Intelligence. Given a captured bug and structured evidence (stack, git log, blast-radius, recall hits), produce a concise root-cause analysis and a minimal fix proposal. Never invent files that aren\'t in evidence; never propose a patch you cannot back with the evidence.',
        cache_control: { type: 'ephemeral' },
      }],
      tools: [{
        name: 'propose_investigation',
        description: 'Record a bug investigation result.',
        input_schema: {
          type: 'object',
          properties: {
            root_cause: { type: 'string', description: 'One sentence describing the root cause.' },
            files_to_change: { type: 'array', items: { type: 'string' } },
            lines_changed: { type: 'integer', minimum: 0 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            suggested_patch: {
              type: ['string', 'null'],
              description: 'Unified diff, or null when the agent cannot confidently produce one.',
            },
          },
          required: ['root_cause', 'files_to_change', 'lines_changed', 'confidence', 'suggested_patch'],
        },
      }],
      tool_choice: { type: 'tool', name: 'propose_investigation' },
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: buildPrompt(bug, evidence),
        }],
      }],
    });

    type ContentBlock = { type: string; input?: unknown };
    const blocks = (response as { content?: ContentBlock[] }).content ?? [];
    const toolUse = blocks.find((b) => b.type === 'tool_use');
    if (!toolUse || !toolUse.input) {
      throw new Error('BugInvestigator brain call returned no tool_use block');
    }
    return toolUse.input as InvestigationDecision;
  };
}

interface AnthropicLike {
  beta: {
    promptCaching: {
      messages: {
        create: (req: unknown) => Promise<unknown>;
      };
    };
  };
}

function buildPrompt(bug: BugRow, evidence: BugEvidence): string {
  return [
    `# Bug under investigation`,
    ``,
    `**fingerprint:** ${bug.fingerprint}`,
    `**source:** ${bug.source}`,
    `**error:** ${bug.error_name}: ${bug.message}`,
    `**top_frame:** ${bug.top_frame ?? '(none)'}`,
    `**occurrences:** ${bug.occurrence_count}`,
    `**severity:** ${bug.severity}`,
    ``,
    `## Stack`,
    evidence.stack ?? '(no stack captured)',
    ``,
    `## Git log on file (last 10)`,
    evidence.gitLog.length === 0
      ? '(no git history available)'
      : evidence.gitLog.map(g => `- ${g.sha} (${g.author}, ${g.date}) ${g.subject}`).join('\n'),
    ``,
    `## Blast radius`,
    evidence.blastRadius
      ? `Repo: ${evidence.blastRadius.repo}, file: ${evidence.blastRadius.file}, ${evidence.blastRadius.edgeCount} edges`
      : '(blast radius unavailable)',
    ``,
    `## Recall (similar past investigations / decisions)`,
    evidence.recall.length === 0
      ? '(no similar past work found)'
      : evidence.recall.map(r => `- [${r.source}/${r.id}] ${r.snippet} (confidence ${r.confidence.toFixed(2)})`).join('\n'),
    ``,
    `Produce one investigation via the propose_investigation tool. If you cannot confidently produce a patch, return null for suggested_patch — a null patch with a strong root_cause is more useful than a fabricated diff.`,
  ].join('\n');
}
