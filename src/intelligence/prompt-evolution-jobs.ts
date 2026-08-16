import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { getAllTemplates, getActiveTemplate, upsertTemplate } from '../db/queries/research-cache.js';
import { ALL_TRIGGER_TYPES, type TriggerType } from './cost-gate.js';
import { bucketCallParams } from '../services/model-config.js';

/**
 * ADR-039 AC-13: closed-set trigger list the nightly OPRO sweep
 * iterates. Sourced from `ALL_TRIGGER_TYPES` so adding a new
 * TriggerType automatically extends the sweep — no need to remember a
 * second array. Imported by `web-server.js` at the watchers boot block
 * (the 6-hour PromptEvolution tick).
 *
 * Today this is identical to `ALL_TRIGGER_TYPES` itself; the indirect
 * export exists so future opt-outs (e.g. excluding `alert` if it never
 * accumulates enough outcomes for OPRO to learn from) can be made here
 * without touching cost-gate.ts.
 */
export const OPRO_SWEEP_TRIGGER_TYPES: readonly TriggerType[] = ALL_TRIGGER_TYPES;

function getClient(apiKey: string) {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  return new Anthropic({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL ? {
      baseURL,
      defaultHeaders: { Authorization: `Bearer ${apiKey}` },
    } : {}),
  });
}

export async function runOPRO(db: Database.Database, triggerType: string, apiKey: string): Promise<void> {
  const client = getClient(apiKey);
  const templates = getAllTemplates(db, triggerType);
  if (templates.length === 0) return;

  const active = templates.find(t => t.is_active === 1);
  if (!active) return;

  const outcomes = db.prepare(`
    SELECT po.trigger_input, po.quality_score, po.relevance_score, po.depth_score, po.actionability_score
    FROM prompt_outcomes po
    WHERE po.template_id = ? AND po.quality_score IS NOT NULL
    ORDER BY po.quality_score DESC
    LIMIT 20
  `).all(active.id) as { trigger_input: string; quality_score: number; relevance_score: number; depth_score: number; actionability_score: number }[];

  if (outcomes.length < 10) return;

  const top5 = outcomes.slice(0, 5);
  const bottom5 = outcomes.slice(-5);

  const versionHistory = templates
    .filter(t => t.avg_quality_score !== null)
    .map(t => `v${t.version} (score: ${t.avg_quality_score?.toFixed(2)})`)
    .join(', ');

  const metaPrompt = `You are optimizing a research prompt template for a code research system.

Previous versions with effectiveness scores:
${versionHistory || 'v1 (baseline)'}

Top 5 highest-scoring outputs (these worked well):
${top5.map((o, i) => `${i + 1}. "${o.trigger_input.slice(0, 100)}" → score ${o.quality_score.toFixed(2)}`).join('\n')}

Bottom 5 lowest-scoring outputs (these failed):
${bottom5.map((o, i) => `${i + 1}. "${o.trigger_input.slice(0, 100)}" → score ${o.quality_score.toFixed(2)}`).join('\n')}

Current active template:
"""
${active.template.slice(0, 1500)}
"""

Propose 2 new prompt variants that should score higher than ${active.avg_quality_score?.toFixed(2) ?? '0.5'}.
Each variant should address a specific failure mode from the worst outputs.`;

  const oproBucketParams = bucketCallParams(db, 'analyse', 2048);
  try {
    const response = await client.beta.promptCaching.messages.create({
      ...oproBucketParams,
      temperature: 0.7,
      system: [{ type: 'text', text: 'You are a prompt optimization expert. Return exactly 2 improved prompt template variants.', cache_control: { type: 'ephemeral' } }],
      tools: [{
        name: 'propose_variants',
        description: 'Propose improved prompt template variants',
        input_schema: {
          type: 'object' as const,
          properties: {
            variant_1: { type: 'string', description: 'First improved template (full text)' },
            variant_2: { type: 'string', description: 'Second improved template (full text)' },
            reasoning: { type: 'string', description: 'Why these should perform better' },
          },
          required: ['variant_1', 'variant_2', 'reasoning'],
        },
      }],
      tool_choice: { type: 'tool', name: 'propose_variants' },
      messages: [{ role: 'user', content: metaPrompt }],
    });

    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return;

    const { variant_1, variant_2 } = block.input as { variant_1: string; variant_2: string; reasoning: string };
    const maxVersion = Math.max(...templates.map(t => t.version));

    upsertTemplate(db, {
      triggerType, version: maxVersion + 1, template: variant_1,
      isActive: false, abWeight: 0.2, evolutionSource: 'opro', parentVersion: active.version,
    });
    upsertTemplate(db, {
      triggerType, version: maxVersion + 2, template: variant_2,
      isActive: false, abWeight: 0.1, evolutionSource: 'opro', parentVersion: active.version,
    });
  } catch { /* OPRO failed — non-fatal */ }
}

export async function runTextGradRepair(db: Database.Database, outcomeId: number, apiKey: string): Promise<void> {
  const client = getClient(apiKey);

  const outcome = db.prepare(`
    SELECT po.trigger_input, po.quality_score, pt.template, pt.id as template_id, pt.known_dead_ends
    FROM prompt_outcomes po
    JOIN prompt_templates pt ON po.template_id = pt.id
    WHERE po.id = ?
  `).get(outcomeId) as { trigger_input: string; quality_score: number; template: string; template_id: number; known_dead_ends: string | null } | undefined;

  if (!outcome) return;

  const repairPrompt = `This research prompt produced a poor result (score: ${outcome.quality_score?.toFixed(2)}).

Prompt (truncated): "${outcome.template.slice(0, 800)}"
Input that failed: "${outcome.trigger_input.slice(0, 200)}"

What single instruction, added to the prompt, would have prevented this failure? Be specific and actionable (1 sentence max).`;

  const repairBucketParams = bucketCallParams(db, 'fetch', 128);
  try {
    const response = await client.beta.promptCaching.messages.create({
      ...repairBucketParams,
      temperature: 0,
      system: [{ type: 'text', text: 'You repair prompts by proposing one specific instruction to prevent failures.', cache_control: { type: 'ephemeral' } }],
      tools: [{
        name: 'repair_instruction',
        description: 'Propose a repair instruction',
        input_schema: {
          type: 'object' as const,
          properties: {
            instruction: { type: 'string', description: 'Single instruction to add to prevent this failure' },
          },
          required: ['instruction'],
        },
      }],
      tool_choice: { type: 'tool', name: 'repair_instruction' },
      messages: [{ role: 'user', content: repairPrompt }],
    });

    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return;

    const { instruction } = block.input as { instruction: string };
    const existing: string[] = outcome.known_dead_ends ? JSON.parse(outcome.known_dead_ends) : [];
    existing.push(instruction);
    if (existing.length > 10) existing.shift();

    db.prepare('UPDATE prompt_templates SET known_dead_ends = ? WHERE id = ?')
      .run(JSON.stringify(existing), outcome.template_id);
  } catch { /* TextGrad failed — non-fatal */ }
}

export function checkABPromotion(db: Database.Database, triggerType: string): void {
  const candidates = db.prepare(`
    SELECT id, version, invocation_count, avg_quality_score, ab_weight
    FROM prompt_templates
    WHERE trigger_type = ? AND is_active = 0 AND deprecated_at IS NULL AND ab_weight > 0 AND invocation_count >= 30
  `).all(triggerType) as { id: number; version: number; invocation_count: number; avg_quality_score: number | null; ab_weight: number }[];

  if (candidates.length === 0) return;

  const active = getActiveTemplate(db, triggerType);
  if (!active || active.avg_quality_score === null) return;

  for (const candidate of candidates) {
    if (candidate.avg_quality_score === null) continue;

    const candidateOutcomes = db.prepare(
      `SELECT quality_score FROM prompt_outcomes WHERE template_id = ? AND quality_score IS NOT NULL ORDER BY created_at DESC LIMIT 30`
    ).all(candidate.id) as { quality_score: number }[];

    const activeOutcomes = db.prepare(
      `SELECT quality_score FROM prompt_outcomes WHERE template_id = ? AND quality_score IS NOT NULL ORDER BY created_at DESC LIMIT 30`
    ).all(active.id) as { quality_score: number }[];

    const pairs = Math.min(candidateOutcomes.length, activeOutcomes.length, 30);
    if (pairs < 30) continue;

    let wins = 0;
    for (let i = 0; i < pairs; i++) {
      if (candidateOutcomes[i].quality_score > activeOutcomes[i].quality_score) wins++;
    }

    const winRate = wins / pairs;
    if (winRate >= 0.6) {
      db.prepare('UPDATE prompt_templates SET is_active = 0 WHERE trigger_type = ? AND is_active = 1').run(triggerType);
      db.prepare('UPDATE prompt_templates SET is_active = 1, ab_weight = 1.0, promoted_at = datetime(\'now\') WHERE id = ?').run(candidate.id);
    } else if (winRate < 0.4) {
      db.prepare('UPDATE prompt_templates SET deprecated_at = datetime(\'now\'), ab_weight = 0 WHERE id = ?').run(candidate.id);
    }
  }
}
