import type Database from 'better-sqlite3';

export interface ClaudeCodeResearchRow {
  id: number;
  input_hash: string;
  trigger_type: string;
  question: string;
  repos: string;
  template_id: number | null;
  result: string;
  confidence: number | null;
  quality_score: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  model: string | null;
  expires_at: string;
  created_at: string;
}

export interface PromptTemplateRow {
  id: number;
  trigger_type: string;
  version: number;
  template: string;
  system_context: string | null;
  effectiveness_score: number;
  invocation_count: number;
  avg_quality_score: number | null;
  is_active: number;
  ab_weight: number;
  promoted_at: string | null;
  deprecated_at: string | null;
  evolution_source: string;
  parent_version: number | null;
  known_dead_ends: string | null;
  high_signal_paths: string | null;
  created_at: string;
}

export interface PromptOutcomeRow {
  id: number;
  template_id: number;
  research_id: number | null;
  trigger_input: string;
  quality_score: number | null;
  relevance_score: number | null;
  depth_score: number | null;
  actionability_score: number | null;
  user_feedback: number | null;
  context_was_used: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  created_at: string;
}

export function getCachedResearch(db: Database.Database, inputHash: string): ClaudeCodeResearchRow | null {
  return db.prepare(
    `SELECT * FROM claude_code_research WHERE input_hash = ? AND expires_at > datetime('now')`
  ).get(inputHash) as ClaudeCodeResearchRow | null;
}

export function upsertResearch(db: Database.Database, data: {
  inputHash: string;
  triggerType: string;
  question: string;
  repos: string[];
  templateId: number | null;
  result: string;
  confidence: number | null;
  qualityScore: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  model: string | null;
}): number {
  const ttlHours = 24;
  const stmt = db.prepare(`
    INSERT INTO claude_code_research (input_hash, trigger_type, question, repos, template_id, result, confidence, quality_score, tokens_used, cost_usd, latency_ms, model, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${ttlHours} hours'))
    ON CONFLICT(input_hash) DO UPDATE SET
      result = excluded.result,
      confidence = excluded.confidence,
      quality_score = excluded.quality_score,
      tokens_used = excluded.tokens_used,
      cost_usd = excluded.cost_usd,
      latency_ms = excluded.latency_ms,
      model = excluded.model,
      expires_at = excluded.expires_at
  `);
  const info = stmt.run(
    data.inputHash, data.triggerType, data.question,
    JSON.stringify(data.repos), data.templateId, data.result,
    data.confidence, data.qualityScore, data.tokensUsed,
    data.costUsd, data.latencyMs, data.model
  );
  return Number(info.lastInsertRowid);
}

export function pruneExpiredResearch(db: Database.Database): number {
  const info = db.prepare(`DELETE FROM claude_code_research WHERE expires_at <= datetime('now')`).run();
  return info.changes;
}

export function getActiveTemplate(db: Database.Database, triggerType: string): PromptTemplateRow | null {
  return db.prepare(
    `SELECT * FROM prompt_templates WHERE trigger_type = ? AND is_active = 1 AND deprecated_at IS NULL ORDER BY version DESC LIMIT 1`
  ).get(triggerType) as PromptTemplateRow | null;
}

export function getABCandidates(db: Database.Database, triggerType: string): PromptTemplateRow[] {
  return db.prepare(
    `SELECT * FROM prompt_templates WHERE trigger_type = ? AND ab_weight > 0 AND deprecated_at IS NULL ORDER BY version DESC`
  ).all(triggerType) as PromptTemplateRow[];
}

export function getAllTemplates(db: Database.Database, triggerType: string): PromptTemplateRow[] {
  return db.prepare(
    `SELECT * FROM prompt_templates WHERE trigger_type = ? ORDER BY version DESC`
  ).all(triggerType) as PromptTemplateRow[];
}

export function upsertTemplate(db: Database.Database, data: {
  triggerType: string;
  version: number;
  template: string;
  systemContext?: string;
  isActive?: boolean;
  abWeight?: number;
  evolutionSource?: string;
  parentVersion?: number;
}): number {
  const stmt = db.prepare(`
    INSERT INTO prompt_templates (trigger_type, version, template, system_context, is_active, ab_weight, evolution_source, parent_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trigger_type, version) DO UPDATE SET
      template = excluded.template,
      system_context = excluded.system_context,
      is_active = excluded.is_active,
      ab_weight = excluded.ab_weight,
      evolution_source = excluded.evolution_source
  `);
  const info = stmt.run(
    data.triggerType, data.version, data.template,
    data.systemContext ?? null, data.isActive ? 1 : 0,
    data.abWeight ?? 0, data.evolutionSource ?? 'manual',
    data.parentVersion ?? null
  );
  return Number(info.lastInsertRowid);
}

export function incrementTemplateInvocations(db: Database.Database, templateId: number): void {
  db.prepare(`UPDATE prompt_templates SET invocation_count = invocation_count + 1 WHERE id = ?`).run(templateId);
}

export function recordOutcome(db: Database.Database, data: {
  templateId: number;
  researchId: number | null;
  triggerInput: string;
  qualityScore: number | null;
  relevanceScore: number | null;
  depthScore: number | null;
  actionabilityScore: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  /**
   * ADR-039 AC-19 (2026-06-29): join key back to cypher_sessions for
   * refinement-enabled dispatch measurement. Optional — legacy
   * callers (jira_analyze / chat / investigate / alert triggers) leave
   * it NULL and the AC-19 dogfood SQL filters those out.
   */
  sessionId?: string | null;
}): number {
  const stmt = db.prepare(`
    INSERT INTO prompt_outcomes (template_id, research_id, trigger_input, quality_score, relevance_score, depth_score, actionability_score, tokens_used, cost_usd, latency_ms, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    data.templateId, data.researchId, data.triggerInput,
    data.qualityScore, data.relevanceScore, data.depthScore,
    data.actionabilityScore, data.tokensUsed, data.costUsd, data.latencyMs,
    data.sessionId ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function updateOutcomeFeedback(db: Database.Database, researchId: number, feedback: number): void {
  db.prepare(`UPDATE prompt_outcomes SET user_feedback = ? WHERE research_id = ?`).run(feedback, researchId);
}

// ── ADR-039 AC-14/AC-15: user_verdict capture ───────────────────────────────
//
// The 4-enum user disagreement signal that lets OPRO learn about prompt
// clarity (right question?) rather than only output quality (right answer?).
// CHECK constraint at the v86 migration enforces value validity; this
// helper validates upstream so the caller gets a clean error instead of a
// SQLite CHECK rejection.
export const USER_VERDICT_VALUES = ['useful', 'wrong_question', 'wrong_scope', 'unrated'] as const;
export type UserVerdict = typeof USER_VERDICT_VALUES[number];

export function isUserVerdict(value: unknown): value is UserVerdict {
  return typeof value === 'string' && (USER_VERDICT_VALUES as readonly string[]).includes(value);
}

/**
 * Write `user_verdict` onto the most-recent goal_refinement
 * prompt_outcomes row whose `trigger_input` matches the session's
 * `goal`. Returns the updated row id, or `null` when no matching row
 * exists yet (typical when T8 hasn't wired the scope-phase scoring
 * call into the loop yet — the row only appears once
 * `scoreRefinedGoal()` runs).
 *
 * Linkage rationale: `prompt_outcomes` has no `session_id` column
 * (it's a learning-substrate table from ADR-021, not a per-session
 * ledger). The (trigger_input, template_id) pair is the closest
 * stable join key. The loop persists `cypher_sessions.goal` and uses
 * that same string as `triggerInput` when calling QualityScorer, so
 * the match is exact for non-mutated goals.
 *
 * Tie-break: most-recent `id` wins if multiple rows match — handles
 * the edge case where the same fuzzy goal got re-scored across
 * template versions (A/B). The chosen row is the one the user just
 * saw a verdict for, which is the latest write.
 *
 * Returns `{ ok: true, id }` on success, `{ ok: false, reason }` on
 * miss. The endpoint translates the miss to HTTP 404 with code
 * `OUTCOME_ROW_NOT_FOUND` so the UI can show a "no scope phase ran
 * for this session yet" affordance instead of a generic error.
 */
export function updateUserVerdict(
  db: Database.Database,
  sessionId: string,
  verdict: UserVerdict,
): { ok: true; id: number } | { ok: false; reason: 'SESSION_NOT_FOUND' | 'OUTCOME_ROW_NOT_FOUND' } {
  const session = db
    .prepare(`SELECT goal FROM cypher_sessions WHERE session_id = ?`)
    .get(sessionId) as { goal: string } | undefined;
  if (!session) {
    return { ok: false, reason: 'SESSION_NOT_FOUND' };
  }

  // Find the latest goal_refinement outcome row for this session's
  // goal. Template join restricts to goal_refinement trigger; ORDER
  // BY id DESC picks the freshest row when an A/B template change
  // produced multiple matches.
  const row = db
    .prepare(`
      SELECT po.id
      FROM prompt_outcomes po
      JOIN prompt_templates pt ON pt.id = po.template_id
      WHERE pt.trigger_type = 'goal_refinement'
        AND po.trigger_input = ?
      ORDER BY po.id DESC
      LIMIT 1
    `)
    .get(session.goal) as { id: number } | undefined;

  if (!row) {
    return { ok: false, reason: 'OUTCOME_ROW_NOT_FOUND' };
  }

  db.prepare(`UPDATE prompt_outcomes SET user_verdict = ? WHERE id = ?`).run(verdict, row.id);
  return { ok: true, id: row.id };
}

export function insertExemplar(db: Database.Database, data: {
  triggerType: string;
  repo: string;
  area: string | null;
  inputSummary: string;
  outputSummary: string;
  qualityScore: number;
}): void {
  db.prepare(`
    INSERT INTO research_exemplars (trigger_type, repo, area, input_summary, output_summary, quality_score)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.triggerType, data.repo, data.area, data.inputSummary, data.outputSummary, data.qualityScore);
}

export function getExemplars(db: Database.Database, triggerType: string, repo?: string, limit = 5): { input_summary: string; output_summary: string }[] {
  if (repo) {
    return db.prepare(
      `SELECT input_summary, output_summary FROM research_exemplars WHERE trigger_type = ? AND repo = ? AND quality_score >= 0.8 ORDER BY quality_score DESC LIMIT ?`
    ).all(triggerType, repo, limit) as { input_summary: string; output_summary: string }[];
  }
  return db.prepare(
    `SELECT input_summary, output_summary FROM research_exemplars WHERE trigger_type = ? AND quality_score >= 0.8 ORDER BY quality_score DESC LIMIT ?`
  ).all(triggerType, limit) as { input_summary: string; output_summary: string }[];
}

export function getResearchByQuestion(db: Database.Database, question: string): ClaudeCodeResearchRow | null {
  return db.prepare(
    `SELECT * FROM claude_code_research WHERE question = ? ORDER BY created_at DESC LIMIT 1`
  ).get(question) as ClaudeCodeResearchRow | null;
}

export function getResearchStats(db: Database.Database): {
  totalInvocations: number;
  cacheHits: number;
  avgQuality: number | null;
  totalCost: number;
  activeTemplates: number;
} {
  const total = (db.prepare(`SELECT COUNT(*) as c FROM claude_code_research`).get() as { c: number }).c;
  const avgQ = (db.prepare(`SELECT AVG(quality_score) as avg FROM prompt_outcomes WHERE quality_score IS NOT NULL`).get() as { avg: number | null }).avg;
  const cost = (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM claude_code_research`).get() as { total: number }).total;
  const active = (db.prepare(`SELECT COUNT(*) as c FROM prompt_templates WHERE is_active = 1`).get() as { c: number }).c;
  return { totalInvocations: total, cacheHits: 0, avgQuality: avgQ, totalCost: cost, activeTemplates: active };
}
