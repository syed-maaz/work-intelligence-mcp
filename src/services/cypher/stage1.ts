/**
 * ADR-042 Phase 1 — Stage 1 (Prompt Generation).
 *
 * The `1a → 1b → generate|ask` shape from ADR-042 § Decision:
 *
 *   1a — FETCH (mechanical, parallel):
 *        - embed the goal ONCE
 *        - fan out cosine lookups in parallel across every local
 *          embedding store: prompt_memory + message_embeddings
 *          (doc_embeddings is DEFERRED per ADR-042 Blocker-2 —
 *          the store does not exist yet; treated as absent).
 *        - list candidate skills by recognition (getCatalogHint's
 *          existing semantic + word-overlap output)
 *        - gather all into a single evidence bundle
 *
 *   1b — LLM READ + REASON + WEIGH (one pass) — implemented by the
 *        caller (loop.ts) using the assembled evidence in its
 *        refiner system prompt. This module produces the evidence;
 *        it does NOT run the LLM.
 *
 *   1c — BRANCH — the caller decides; this module is source-of-truth
 *        for the input evidence.
 *
 * KEY CONTRACT (per ADR-042 § HIGH-3 audit response):
 *   - 1a hits pass ID + score + ≤120-char snippet to 1b — no full
 *     bodies, no per-hit fetch, no external network call. Enforced
 *     by SNIPPET_MAX_CHARS.
 *   - 1a is bounded by parallel-fetch wall-clock (~500ms internal
 *     race on semanticSearch); this module race-caps at 800ms total.
 *   - Returns a stable, JSON-serialisable bundle: pass through to
 *     the refiner system prompt.
 *
 * Cross-refs:
 *   - docs/docs/adr/adr-042-prompt-generation-stage.md
 *   - src/services/embedder.ts:semanticSearch, rankPromptMemory
 *   - src/services/cypher/tool-catalog.ts:getCatalogHint
 *   - src/services/cypher/loop.ts (Stage 1 wire point at scope entry)
 *   - tests/cypher/stage1.test.ts
 */

import type Database from 'better-sqlite3';

// ── Contract constants (test-visible) ──────────────────────────────────────

/** Max chars of any single 1a-hit snippet passed to 1b. */
export const SNIPPET_MAX_CHARS = 120;

/** Total wall-clock cap for the 1a fetch (parallel fan-out). */
export const STAGE1_FETCH_TIMEOUT_MS = 800;

/** Max hits per fan-out source. Keeps 1b prompt size bounded. */
export const MAX_HITS_PER_SOURCE = 8;

// ── Recall tuning constants (2026-07-24 sweep, ADR-042 AC-U1 revisit) ─────
//
// The three knobs the sweep harness (scripts/stage1-recall-sweep.mjs) walks
// over. Defaults below are the CURRENT production values. The sweep swaps
// them per-combo, scores against .planning/paraphrase-corpus-v1.jsonl, and
// records `.planning/stage1-sweep-<date>.json`. Chosen constants land here.
//
// - RECALL_SIM_GATE_DEFAULT: simGate passed to rankPromptMemory for the
//   prompt_memory branch (Branch A). Lower gate widens the recall net at
//   the cost of noisier top-1; anti-domination inside rankPromptMemory is
//   the counterweight.
// - RECALL_BLEND_SEMANTIC_DEFAULT: multiplier applied to word-overlap raw
//   score when merging with semantic candidates. Word-overlap raw scores
//   are 1..~8; multiplier scales into a comparable band. Higher = word-
//   overlap ranks higher (helps description-matched paraphrases beat
//   noisy semantic top-1).
// - RECALL_ANTI_DOM_TOPK_DEFAULT: number of top catalog candidates that
//   are ALWAYS retained after the anti-domination dedup against
//   prompt_memory (previously: ALL non-pm catalog candidates kept, pm
//   dupes dropped). K=0 keeps legacy behavior; K>0 keeps K catalog
//   candidates even if they duplicate a pm skill.

/** Default simGate for the prompt_memory branch inside stage1Fetch. */
export const RECALL_SIM_GATE_DEFAULT = 0.55;

/** Default multiplier for the word-overlap → merged-score rescale. */
export const RECALL_BLEND_SEMANTIC_DEFAULT = 0.08;

/** Default top-K catalog candidates retained regardless of pm-lane dedup. */
export const RECALL_ANTI_DOM_TOPK_DEFAULT = 0;

// ── Recognition-confidence thresholds (recognition-feedback loop, 2026-07-17) ─
//
// The confidence flag drives the low-confidence human-feedback prompt at the
// dispatch surface. It is computed over the MERGED candidate pool
// (catalog_candidates ∪ prompt_memory_hits), whose scores are already
// rescaled into the ~0..0.4 band (see stage1Fetch Branch A/C comments — pm
// scores are anti-domination-adjusted, word-overlap rescaled to 0.05..0.4,
// semantic sim capped in [0,1]). The gate/margin defaults are tuned for THAT
// band, NOT the raw-sim 0.72 production gate (which mis-sets against
// nomic-embed-text — see project_recognition_feedback_loop_design.md caveat).
//
// This flag makes TRUST self-improving (down-weight a wrong skill via priors);
// it does NOT by itself fix the SCORING problem (recall). See the honest caveat
// in the design memo.
//
// - GATE: top-1 merged score below this → low confidence (nothing looks strong).
// - MARGIN: (top1 − top2) below this → low confidence (top-2 too close to call).
// Both env-tunable so the LITE soak can retune without a code change.

/** Default top-1 merged-score gate below which recognition is "low". */
export const RECOGNITION_CONFIDENCE_GATE_DEFAULT = 0.3;

/** Default top1−top2 margin below which recognition is "low" (tied field). */
export const RECOGNITION_CONFIDENCE_MARGIN_DEFAULT = 0.1;

/** Read the gate from env (RECOGNITION_CONFIDENCE_GATE), clamped to [0,1]. */
export function recognitionGate(): number {
  const raw = Number(process.env.RECOGNITION_CONFIDENCE_GATE);
  if (!Number.isFinite(raw)) return RECOGNITION_CONFIDENCE_GATE_DEFAULT;
  return Math.min(1, Math.max(0, raw));
}

/** Read the margin from env (RECOGNITION_CONFIDENCE_MARGIN), clamped to [0,1]. */
export function recognitionMargin(): number {
  const raw = Number(process.env.RECOGNITION_CONFIDENCE_MARGIN);
  if (!Number.isFinite(raw)) return RECOGNITION_CONFIDENCE_MARGIN_DEFAULT;
  return Math.min(1, Math.max(0, raw));
}

// ── Types ──────────────────────────────────────────────────────────────────

/** A single evidence tuple from ONE fan-out source. */
export interface Stage1Hit {
  /** Source label — 'prompt_memory' | 'messages' | 'catalog_hint'. */
  source: 'prompt_memory' | 'messages' | 'catalog_hint' | 'doc';
  /** Stable id (message_id, chosen_skill, or skill_name). */
  id: string;
  /** Ranking score in [0,1] — cosine sim for embeddings, or token overlap. */
  score: number;
  /**
   * ≤120-char summary. NEVER a full body — 1a is a recognition probe,
   * not retrieval. Stage 3 does retrieval.
   */
  snippet: string;
}

/** The complete 1a fetch output — the "evidence bundle" for 1b. */
export interface Stage1Evidence {
  /** The goal text 1a was probed with (raw, not embedded). */
  goal: string;
  /** True when Ollama was reachable AND at least one embedding fired. */
  semantic_available: boolean;
  /** Hits by source, each source pre-trimmed to MAX_HITS_PER_SOURCE. */
  prompt_memory_hits: Stage1Hit[];
  message_hits: Stage1Hit[];
  /** Doc-corpus hits (ADRs / architecture / epics) from doc_embeddings — ADR-042 Gap 2. */
  doc_hits: Stage1Hit[];
  /** Skill candidates from getCatalogHint (semantic OR word-overlap path). */
  catalog_candidates: Stage1Hit[];
  /** Provenance: which source fired the catalog_candidates. */
  catalog_source: 'semantic' | 'word-overlap' | 'empty';
  /** Wall-clock ms 1a spent gathering. Diagnostic for tuning. */
  fetch_wallclock_ms: number;
  /** Non-fatal errors from individual fan-out branches (for logs, not the LLM). */
  errors: string[];
  /**
   * Recognition-feedback loop (2026-07-17). 'low' when the merged candidate
   * pool (catalog_candidates ∪ prompt_memory_hits) has no clear winner:
   * either the top-1 merged score is below `recognitionGate()`, or the
   * top1−top2 margin is below `recognitionMargin()`, or there are no
   * candidates at all. 'high' otherwise. Drives the low-confidence human
   * feedback prompt at the dispatch surface. Never blocks anything.
   */
  recognition_confidence: 'high' | 'low';
  /**
   * The recognition-confidence signal, retained for surfacing + diagnostics.
   * `top_skill` is the merged top-1 candidate skill (the one the feedback
   * prompt asks the user about); null when the pool is empty.
   */
  confidence_signal: {
    top_skill: string | null;
    top1_score: number;
    top2_score: number;
    gate: number;
    margin: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Trim any snippet to the contract cap; single-line whitespace normalise. */
export function truncateSnippet(s: string, max = SNIPPET_MAX_CHARS): string {
  const oneLine = String(s ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/**
 * Compute the recognition-confidence flag over the merged candidate pool.
 *
 * Pure (no DB, no env read except the two threshold getters). The pool is
 * `catalog_candidates` merged with `prompt_memory_hits`, de-duplicated by
 * skill id keeping the higher score, then sorted descending. Confidence is
 * 'low' when ANY of:
 *   - the pool is empty (nothing recognised — cold start), OR
 *   - top1 score < gate (nothing looks strong enough), OR
 *   - top1 − top2 < margin (top-2 too close to separate).
 * 'high' only when there is a clear, strong single winner.
 *
 * The `top_skill` returned is the merged top-1 id — the skill the
 * low-confidence feedback prompt asks the user about.
 */
export function computeRecognitionConfidence(
  catalogCandidates: Stage1Hit[],
  promptMemoryHits: Stage1Hit[],
  gate = recognitionGate(),
  margin = recognitionMargin(),
): { recognition_confidence: 'high' | 'low'; confidence_signal: Stage1Evidence['confidence_signal'] } {
  // Merge by skill id, keep the higher score per skill.
  const bySkill = new Map<string, number>();
  for (const h of [...catalogCandidates, ...promptMemoryHits]) {
    const prev = bySkill.get(h.id);
    if (prev === undefined || h.score > prev) bySkill.set(h.id, h.score);
  }
  const ranked = [...bySkill.entries()].sort((a, b) => b[1] - a[1]);
  const top1 = ranked[0];
  const top2 = ranked[1];
  const top1Score = top1 ? top1[1] : 0;
  const top2Score = top2 ? top2[1] : 0;
  const topSkill = top1 ? top1[0] : null;

  const signal = {
    top_skill: topSkill,
    top1_score: top1Score,
    top2_score: top2Score,
    gate,
    margin,
  };

  // Empty pool, weak top, or tied top-2 → low.
  const isLow =
    ranked.length === 0 ||
    top1Score < gate ||
    top1Score - top2Score < margin;

  return { recognition_confidence: isLow ? 'low' : 'high', confidence_signal: signal };
}

/**
 * Race a Promise against a timeout. On timeout, resolves with `fallback`
 * — never rejects, never throws. 1a must degrade gracefully.
 */
async function raceTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race<T>([
    promise.catch(() => fallback),
    new Promise<T>((res) => setTimeout(() => res(fallback), ms)),
  ]);
}

/** Parse getCatalogHint's rendered string into structured `Stage1Hit`s. */
export function parseCatalogHintOutput(hint: string): {
  candidates: Stage1Hit[];
  source: 'semantic' | 'word-overlap' | 'empty';
} {
  if (!hint || !hint.trim()) return { candidates: [], source: 'empty' };
  const lines = hint.split('\n');
  const header = lines[0] || '';
  const source: 'semantic' | 'word-overlap' | 'empty' =
    header.includes('learned from similar past prompts') ? 'semantic'
      : header.includes('description-overlap') ? 'word-overlap'
        : 'empty';
  if (source === 'empty') return { candidates: [], source };

  const candidates: Stage1Hit[] = [];
  for (const line of lines.slice(1)) {
    // Semantic line: "  - <skill> (sim=0.83, success=0.72, matches=5)"
    // Overlap line:  "  - <skill> (score=3) [task_classes: …]"
    const m = line.match(/^\s*-\s*([\w-]+)\s*\(([^)]+)\)/);
    if (!m) continue;
    const skill = m[1]!;
    const meta = m[2]!;
    // Extract the numeric score signal — sim= for semantic, score= for overlap.
    const simM = meta.match(/sim=([0-9.]+)/);
    const scoreM = meta.match(/score=([0-9.]+)/);
    const rawScore = simM ? parseFloat(simM[1]!) : scoreM ? parseFloat(scoreM[1]!) : 0;
    candidates.push({
      source: 'catalog_hint',
      id: skill,
      score: rawScore,
      snippet: truncateSnippet(`${skill}: ${meta}`),
    });
  }
  return { candidates, source };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the 1a mechanical fetch. Returns the evidence bundle 1b consumes.
 *
 * NEVER throws. NEVER blocks the caller more than STAGE1_FETCH_TIMEOUT_MS.
 * Each fan-out branch is independent — if one source fails, the others
 * still contribute; the failed branch surfaces on `errors`.
 */
export async function stage1Fetch(
  goal: string,
  db: Database.Database,
  opts: {
    timeoutMs?: number;
    maxHitsPerSource?: number;
    /** simGate for the prompt_memory branch (default RECALL_SIM_GATE_DEFAULT). */
    simGate?: number;
    /** Multiplier for word-overlap → merged-score rescale (default RECALL_BLEND_SEMANTIC_DEFAULT). */
    blendSemantic?: number;
    /** Top-K catalog candidates always kept post pm-dedup (default RECALL_ANTI_DOM_TOPK_DEFAULT). */
    antiDomTopK?: number;
  } = {},
): Promise<Stage1Evidence> {
  const goalText = (goal ?? '').trim();
  const timeoutMs = opts.timeoutMs ?? STAGE1_FETCH_TIMEOUT_MS;
  const maxHits = opts.maxHitsPerSource ?? MAX_HITS_PER_SOURCE;
  const simGate = opts.simGate ?? RECALL_SIM_GATE_DEFAULT;
  const blendSemantic = opts.blendSemantic ?? RECALL_BLEND_SEMANTIC_DEFAULT;
  const antiDomTopK = opts.antiDomTopK ?? RECALL_ANTI_DOM_TOPK_DEFAULT;
  const start = Date.now();
  const errors: string[] = [];

  if (!goalText) {
    return {
      goal: '',
      semantic_available: false,
      prompt_memory_hits: [],
      message_hits: [],
      doc_hits: [],
      catalog_candidates: [],
      catalog_source: 'empty',
      fetch_wallclock_ms: Date.now() - start,
      errors,
      // Empty goal → nothing recognised → low confidence.
      ...computeRecognitionConfidence([], []),
    };
  }

  // ── Branch A — prompt_memory recall (per-skill outcome-weighted) ────────
  const promptMemoryBranch: Promise<Stage1Hit[]> = (async () => {
    try {
      const { rankPromptMemory } = await import('../embedder.js');
      // Stage 1 uses simGate=0.55 (production default is 0.72). At 0.55
      // paraphrases in the 0.55-0.72 band become visible; the anti-domination
      // logic INSIDE rankPromptMemory (2026-07-15) prevents wi-investigate
      // from dominating by log-saturating match counts + specificity scoring.
      // Measured before/after: without anti-dom the lower gate hurt recall
      // (3/10 → 2/10); with anti-dom the lower gate should be neutral-or-better.
      const ranked = await rankPromptMemory(goalText, db, simGate);
      if (!ranked || ranked.length === 0) return [];
      return ranked.slice(0, maxHits).map((r): Stage1Hit => ({
        source: 'prompt_memory',
        id: r.skill,
        // Use the anti-domination-ADJUSTED score, not raw sim. The adjusted
        // score has log-saturation + specificity applied, so a 432-row
        // wi-investigate scoring 0.82 becomes ~0.05 while a 5-row
        // wi-blast-radius scoring 0.65 becomes ~0.24. This makes pm scores
        // comparable to the rescaled catalog scores (both bounded around
        // 0..0.4) so top-5 across the merged evidence bundle isn't
        // dominated by pm hits with raw sim of 0.7+.
        score: r.score,
        snippet: truncateSnippet(
          `${r.skill} (sim=${r.sim.toFixed(2)}, matches=${r.matches}, score=${r.score.toFixed(2)})`,
        ),
      }));
    } catch (e) {
      errors.push(`prompt_memory: ${(e as Error).message}`);
      return [];
    }
  })();

  // ── Branch B — message_embeddings semantic search ───────────────────────
  const messageBranch: Promise<Stage1Hit[]> = (async () => {
    try {
      const { semanticSearch } = await import('../embedder.js');
      const hits = await semanticSearch(goalText, db, maxHits);
      if (hits.length === 0) return [];
      // Fetch subject/snippets in ONE query — we need one line per hit.
      const placeholders = hits.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT id, source, subject, content FROM messages WHERE id IN (${placeholders})`,
        )
        .all(...hits.map((h) => h.message_id)) as Array<{
          id: number;
          source: string;
          subject: string | null;
          content: string | null;
        }>;
      const byId = new Map(rows.map((r) => [r.id, r]));
      return hits.map((h): Stage1Hit => {
        const row = byId.get(h.message_id);
        const text = row ? [row.source, row.subject, row.content].filter(Boolean).join(' — ') : '';
        return {
          source: 'messages',
          id: String(h.message_id),
          score: h.score,
          snippet: truncateSnippet(text),
        };
      });
    } catch (e) {
      errors.push(`messages: ${(e as Error).message}`);
      return [];
    }
  })();

  // ── Branch D — doc_embeddings semantic search (ADR-042 Gap 2) ───────────
  // ADR / architecture / epic corpus. Recognition-only: returns doc identity
  // (path/title/kind) so a doc-shaped goal ("audit ADR-044") surfaces the ADR
  // itself instead of thrashing indexed sources. Deep content retrieval is
  // Stage-3's job, not this. Mirrors Branch B's shape.
  const docBranch: Promise<Stage1Hit[]> = (async () => {
    try {
      const { searchDocs } = await import('../embedder.js');
      const hits = await searchDocs(goalText, db, maxHits);
      return hits.map((h): Stage1Hit => ({
        source: 'doc',
        id: h.path,
        score: h.score,
        snippet: truncateSnippet(`${h.title} — ${h.doc_kind}`),
      }));
    } catch (e) {
      errors.push(`docs: ${(e as Error).message}`);
      return [];
    }
  })();

  // ── Branch C — catalog hint (TWO-TIER: semantic AND word-overlap) ───────
  // Audit HIGH-1 fix: the cascade in getCatalogHint returns semantic OR
  // word-overlap, never both. For paraphrases the semantic path emits
  // wi-investigate (77% corpus skew) and the description-relevant skill
  // gets no visibility. Stage 1 runs BOTH lanes in parallel and merges
  // with provenance; caller (1b LLM) sees semantic-strong / semantic-weak /
  // description-overlap as distinct evidence lines.
  const catalogBranch: Promise<{ candidates: Stage1Hit[]; source: 'semantic' | 'word-overlap' | 'empty' }> =
    (async () => {
      try {
        // Run both lanes in parallel. Semantic path goes through the full
        // getCatalogHint (so BLOCKER-1 aggregate-prior blend still applies).
        // Word-overlap goes through the newly-exported helper directly, with
        // a lower similarity gate so paraphrases in the 0.55–0.72 band appear.
        const [semanticHint, overlapHint] = await Promise.all([
          (async () => {
            const { getCatalogHint } = await import('./tool-catalog.js');
            return getCatalogHint(goalText, db);
          })(),
          (async () => {
            const { getCatalogHintWordOverlap } = await import('./tool-catalog.js');
            return getCatalogHintWordOverlap(goalText, db);
          })(),
        ]);

        const semanticParsed = parseCatalogHintOutput(semanticHint);
        const overlapParsed = parseCatalogHintOutput(overlapHint);

        // Merge with de-dup + correct provenance labels.
        // - Skill in semantic-only  → "[semantic]"
        // - Skill in word-overlap-only → "[description]"
        // - Skill in BOTH → "[semantic+desc]"
        const semanticIds = new Set(semanticParsed.candidates.map((c) => c.id));
        const overlapIds = new Set(overlapParsed.candidates.map((c) => c.id));
        const merged = new Map<string, Stage1Hit>();

        for (const c of semanticParsed.candidates) {
          const bothLanes = overlapIds.has(c.id);
          const label = bothLanes ? '[semantic+desc]' : '[semantic]';
          merged.set(c.id, {
            source: 'catalog_hint',
            id: c.id,
            score: c.score, // sim in [0,1]
            snippet: truncateSnippet(`${c.id} ${label} sim=${c.score.toFixed(2)}`),
          });
        }
        for (const c of overlapParsed.candidates) {
          if (semanticIds.has(c.id)) continue; // already labelled as both
          // Rescale word-overlap score into a comparable range so the merged
          // sort is meaningful. Word-overlap gives 1..~8; scale to 0.05..0.4.
          merged.set(c.id, {
            source: 'catalog_hint',
            id: c.id,
            score: Math.min(0.4, c.score * blendSemantic),
            snippet: truncateSnippet(`${c.id} [description] score=${c.score}`),
          });
        }

        // Pick canonical source label for downstream: semantic if any semantic
        // candidate present, else word-overlap, else empty.
        const source: 'semantic' | 'word-overlap' | 'empty' =
          semanticParsed.candidates.length > 0
            ? 'semantic'
            : overlapParsed.candidates.length > 0
              ? 'word-overlap'
              : 'empty';

        const list = [...merged.values()].sort((a, b) => b.score - a.score);
        return { candidates: list, source };
      } catch (e) {
        errors.push(`catalog_hint: ${(e as Error).message}`);
        return { candidates: [], source: 'empty' as const };
      }
    })();

  // Parallel gather w/ overall wall-clock cap.
  const [pmHits, msgHits, docHits, catalog] = await Promise.all([
    raceTimeout(promptMemoryBranch, timeoutMs, [] as Stage1Hit[]),
    raceTimeout(messageBranch, timeoutMs, [] as Stage1Hit[]),
    raceTimeout(docBranch, timeoutMs, [] as Stage1Hit[]),
    raceTimeout(catalogBranch, timeoutMs, { candidates: [] as Stage1Hit[], source: 'empty' as const }),
  ]);

  // Trim catalog candidates to same per-source cap
  const catalogTrimmed = catalog.candidates.slice(0, maxHits);

  // ── Anti-domination (audit HIGH-2 fix + 2026-07-24 sweep) ─────────────
  // Per-skill uniqueness across prompt_memory_hits + catalog_candidates:
  // when the same skill appears in BOTH lanes (e.g. wi-investigate shows
  // up in prompt_memory because 50.6% of the corpus is wi-investigate,
  // AND in catalog because its description matches loosely), keep only
  // the higher-scoring instance. Prevents 1b LLM from seeing 4/5 slots
  // filled by the same skill and treating that as strong evidence.
  //
  // ANTI-DOM TOP-K RESERVE (2026-07-24): retain the top-K catalog
  // candidates even if they duplicate a pm skill. K=0 restores legacy
  // "drop all pm-duplicates" behavior; K>0 gives description-strong
  // candidates a floor that pm dominance cannot displace.
  const skillsSeenInPm = new Set(pmHits.map((h) => h.id));
  const catalogDeduped = catalogTrimmed.filter((c, i) => i < antiDomTopK || !skillsSeenInPm.has(c.id));

  // ── ADR-050 R2-B.1 (option c — rerank, 2026-08-05) ──────────────────────
  // Trigger-phrase rerank: read the backfilled trigger_phrases column and
  // stable-partition the catalog candidates so a phrase-matched skill inside
  // the pool rises above non-matching ones. Selection is unchanged (never
  // adds/removes) — only ORDER changes, which is exactly option (c)'s
  // "embed first, then swap in phrase-matcher" contract. Falls back to the
  // deduped list untouched when no phrases match or the query errors.
  try {
    const { getTriggerPhraseHitSkills, rerankByPhraseHit } = await import('./tool-catalog.js');
    const phraseHits = getTriggerPhraseHitSkills(goalText, db);
    if (phraseHits.size > 0) {
      const asIds = catalogDeduped.map((c) => ({ id: c.id, score: c.score }));
      const reranked = rerankByPhraseHit(asIds, phraseHits);
      const order = new Map(reranked.map((c, i) => [c.id, i]));
      catalogDeduped.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
  } catch {
    // rerank failure is non-fatal — keep the deduped order.
  }

  return {
    goal: goalText,
    semantic_available: pmHits.length > 0 || msgHits.length > 0 || docHits.length > 0 || catalog.source === 'semantic',
    prompt_memory_hits: pmHits,
    message_hits: msgHits,
    doc_hits: docHits,
    catalog_candidates: catalogDeduped,
    catalog_source: catalog.source,
    fetch_wallclock_ms: Date.now() - start,
    errors,
    // Confidence over the SAME pool the 1b LLM sees: the deduped catalog
    // candidates ∪ prompt_memory hits. computeRecognitionConfidence merges
    // + dedups by skill id (max score) so a skill in both lanes counts once.
    ...computeRecognitionConfidence(catalogDeduped, pmHits),
  };
}

// ── 1b prompt block helper ────────────────────────────────────────────────

/**
 * Render Stage 1 evidence into the compact prompt block the 1b LLM pass
 * reads. The refiner system prompt appends this block; then a SINGLE LLM
 * call reasons over it and emits either a `refined_goal` JSON brief OR
 * a clarifying question. This function is prompt-boundary code, not the
 * LLM call itself — the loop.ts scope entry does that.
 */
export function renderStage1EvidenceBlock(ev: Stage1Evidence): string {
  const lines: string[] = [];
  lines.push('## Stage 1a evidence (recognition only — do NOT execute anything)');
  lines.push('');
  lines.push(`Goal: ${ev.goal}`);
  lines.push(
    `Semantic path available: ${ev.semantic_available ? 'yes' : 'no (Ollama down or empty stores)'}`,
  );
  lines.push(`Fetch wall-clock: ${ev.fetch_wallclock_ms}ms`);
  lines.push('');

  if (ev.catalog_candidates.length > 0) {
    lines.push(`### Candidate skills (${ev.catalog_source} path)`);
    for (const c of ev.catalog_candidates) {
      lines.push(`  - ${c.snippet}`);
    }
    lines.push('');
  }
  if (ev.prompt_memory_hits.length > 0) {
    lines.push('### Learned skill recall (past dispatches for similar prompts)');
    for (const h of ev.prompt_memory_hits) {
      lines.push(`  - ${h.snippet}`);
    }
    lines.push('');
  }
  if (ev.message_hits.length > 0) {
    lines.push('### Related messages (Jira / Teams / Email / GitHub — recognition, not retrieval)');
    for (const h of ev.message_hits) {
      lines.push(`  - msg#${h.id} sim=${h.score.toFixed(2)}: ${h.snippet}`);
    }
    lines.push('');
  }
  if (ev.doc_hits && ev.doc_hits.length > 0) {
    lines.push('### Related docs (ADRs / architecture / epics — recognition, not retrieval)');
    for (const h of ev.doc_hits) {
      lines.push(`  - ${h.id} sim=${h.score.toFixed(2)}: ${h.snippet}`);
    }
    lines.push('');
  }
  if (
    ev.catalog_candidates.length === 0 &&
    ev.prompt_memory_hits.length === 0 &&
    ev.message_hits.length === 0 &&
    (!ev.doc_hits || ev.doc_hits.length === 0)
  ) {
    lines.push('### No local recognition — cold-start goal.');
    lines.push('Proceed by reasoning from the goal text alone; ask user if ambiguous.');
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(
    'INSTRUCTIONS: In ONE response, either (a) emit a refined_goal JSON brief per the schema, ' +
      'OR (b) emit ONE clarifying question if the goal is genuinely ambiguous. Do NOT dispatch tools; ' +
      'the evidence above is recognition-only. Do NOT do multi-round reasoning — one pass.',
  );
  return lines.join('\n');
}
