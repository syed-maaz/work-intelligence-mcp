/**
 * ADR-053 Phase 2 — PM orchestrator.
 *
 * The coordination-layer PM tier (posture='pm'). Four-step flow per the ADR:
 *   1. Hydrate context (template-hard-coded in MVP; passed in as `brief`).
 *   2. LLM drafts a DAG of sub-tasks   → injected `draftPlan`.
 *   3. Template validator rewrites      → runPlanValidators (structural + templates).
 *   4. Architect reviews; PM emits board cards on approval → injected `emitCard`.
 *
 * Control policy:
 *   - Cycle/structural rejection → re-draft (up to `maxDraftRetries`).
 *   - Architect verdict='revise'  → re-draft with notes (up to `maxReviseCycles`).
 *   - Safety cap: `maxCards` (default 10) hard-stop BEFORE committing any card.
 *
 * The LLM drafter and Architect are injected so the whole orchestration is
 * deterministically unit-testable without a live model call. The live wiring
 * (real drafter/architect + DB card emit) is assembled by the bridge behind
 * ADR_053_ENABLED; this module stays pure.
 *
 * See docs/docs/adr/adr-053-multi-stage-orchestration.md § "Decision — Architecture".
 */
import {
  runPlanValidators,
  type PlanDraft,
  type HydratedBrief,
  type PlanValidator,
  type SubTaskPosture,
} from './pm-templates/index.js';
import featureCrossRepo from './pm-templates/feature-cross-repo.js';
import { architectReview as defaultArchitectReview, type ArchitectReview } from './architect-posture.js';

/** A card the PM commits to the board. */
export interface EmittedCard {
  id: string;
  title: string;
  depends_on: string[];
}

export interface PmDeps {
  /** LLM drafter. Receives the brief + optional revise notes from the architect. */
  draftPlan: (brief: HydratedBrief, reviseNotes?: string[]) => Promise<PlanDraft>;
  /** Architect reviewer. Defaults to the deterministic architectReview. May be async (live LLM pass). */
  architectReview?: (input: { plan: PlanDraft; brief: HydratedBrief }) => ArchitectReview | Promise<ArchitectReview>;
  /** Card emitter — returns the committed card id. Posture is optionally provided for worker bias. */
  emitCard: (card: EmittedCard & { posture?: SubTaskPosture }) => string;
  /** Domain templates to run. Defaults to [feature.cross-repo]. */
  templates?: PlanValidator[];
  /** Hard cap on cards per goal (default 10). */
  maxCards?: number;
  /** Max re-drafts after a structural (cycle) rejection (default 2). */
  maxDraftRetries?: number;
  /** Max architect revise cycles (default 2). */
  maxReviseCycles?: number;
}

export interface PmResult {
  ok: boolean;
  cards?: EmittedCard[];
  rewrites?: number;
  reason?: string;
  /** One-line summary of the plan (ids), for SSE surface polish. */
  plan_summary?: string;
  /** Architect revise notes that were applied before approval, if any. */
  revise_notes_used?: string[];
}

const DEFAULT_TEMPLATES: PlanValidator[] = [featureCrossRepo];

/**
 * Commit the approved plan's cards in topological order (parents before
 * children) so each card's `depends_on` can reference the parent's *committed*
 * task id — not the orchestrator-local draft id. The emitter returns the
 * committed id (e.g. the `task_<draft-id>` PK rewrite in the bridge); on emit
 * failure the whole plan fails — a broken DAG must never be committed
 * (RADAR "emitCard PK-rewrite orphan-edge hazard").
 */
function commitCards(
  validated: PlanDraft,
  emitCard: PmDeps['emitCard'],
): { ok: true; cards: EmittedCard[] } | { ok: false; reason: string } {
  const byId = new Map(validated.sub_tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of validated.sub_tasks) {
    indegree.set(t.id, (t.depends_on ?? []).length);
    for (const d of t.depends_on ?? []) {
      const arr = dependents.get(d) ?? [];
      arr.push(t.id);
      dependents.set(d, arr);
    }
  }

  const queue = validated.sub_tasks
    .filter((t) => (t.depends_on ?? []).length === 0)
    .map((t) => t.id);
  const committedIds = new Map<string, string>();
  const cards: EmittedCard[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const t = byId.get(id);
    if (!t) continue;
    // Resolve dependencies to the parents' committed ids (they are always
    // committed first — Kahn already proved the DAG acyclic).
    const depends_on = (t.depends_on ?? []).map((d) => committedIds.get(d) ?? d);
    const card = {
      id: t.id,
      title: t.title,
      depends_on,
      posture: t.posture,
    } as EmittedCard & { posture?: SubTaskPosture };
    let committedId: string;
    try {
      committedId = emitCard(card);
    } catch (err) {
      return {
        ok: false,
        reason: `card emit failed for '${t.id}': ${(err as Error).message}`,
      };
    }
    committedIds.set(t.id, committedId);
    cards.push({ id: committedId, title: t.title, depends_on });
    for (const child of dependents.get(id) ?? []) {
      const node = byId.get(child);
      if (!node) continue;
      const deg = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, deg);
      if (deg === 0) queue.push(child);
    }
  }

  return { ok: true, cards };
}

/**
 * Run the PM orchestration for a hydrated brief. Returns ok=true with the
 * emitted cards on success, or ok=false + reason on halt (cycle unresolved,
 * architect never approves, emit failure, or max_cards exceeded).
 */
export async function runPmOrchestrator(brief: HydratedBrief, deps: PmDeps): Promise<PmResult> {
  const templates = deps.templates ?? DEFAULT_TEMPLATES;
  const maxCards = deps.maxCards ?? 10;
  const maxDraftRetries = deps.maxDraftRetries ?? 2;
  const maxReviseCycles = deps.maxReviseCycles ?? 2;
  const review = deps.architectReview ?? defaultArchitectReview;

  let reviseNotes: string[] | undefined;
  let totalRewrites = 0;
  let reviseNotesUsed: string[] | undefined;

  for (let reviseCycle = 0; reviseCycle <= maxReviseCycles; reviseCycle++) {
    // Draft + structural/template validation with retry on structural failure.
    let validated: PlanDraft | undefined;
    for (let attempt = 0; attempt <= maxDraftRetries; attempt++) {
      const draft = await deps.draftPlan(brief, reviseNotes);
      const res = runPlanValidators(draft, brief, templates);
      if (res.ok && res.draft) {
        validated = res.draft;
        totalRewrites += res.rewrites?.length ?? 0;
        break;
      }
      // structural failure (e.g. cycle) → re-draft
    }
    if (!validated) {
      return { ok: false, reason: 'plan failed structural validation after retries' };
    }

    // Architect review.
    const verdict = await review({ plan: validated, brief });
    if (verdict.verdict === 'revise') {
      reviseNotes = verdict.notes;
      reviseNotesUsed = verdict.notes;
      continue; // re-draft incorporating notes
    }

    // Approved → enforce safety cap BEFORE committing anything.
    if (validated.sub_tasks.length > maxCards) {
      return {
        ok: false,
        reason: `max_cards exceeded: ${validated.sub_tasks.length} > ${maxCards} (too many cards)`,
      };
    }

    // Commit cards — topological order, fail whole plan on emit failure.
    const committed = commitCards(validated, deps.emitCard);
    if (!committed.ok) {
      return { ok: false, reason: committed.reason };
    }
    const cards = committed.cards;
    // Build a lightweight plan summary: list of node ids (count too)
    const plan_summary = `${cards.length} task(s): ` + cards.map(c => c.id).join(' → ');
    return { ok: true, cards, rewrites: totalRewrites, plan_summary, revise_notes_used: reviseNotesUsed };
  }

  return { ok: false, reason: 'architect did not approve within max revise cycles' };
}

export default runPmOrchestrator;
