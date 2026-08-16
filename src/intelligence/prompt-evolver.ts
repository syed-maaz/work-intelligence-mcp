import type Database from 'better-sqlite3';
import type { TriggerType } from './cost-gate.js';
import { getActiveTemplate, getABCandidates, getExemplars, incrementTemplateInvocations } from '../db/queries/research-cache.js';
import type { PromptTemplateRow } from '../db/queries/research-cache.js';

/**
 * AC-11 grep-anchor constant (ADR-039). Exported so unit tests + audit
 * scripts can confirm the SCOPE-phase trigger is wired into PromptEvolver
 * without scanning for a string literal that could match a comment.
 */
export const GOAL_REFINEMENT_TRIGGER: TriggerType = 'goal_refinement';

export interface PromptTemplate {
  id: number;
  triggerType: TriggerType;
  version: number;
  template: string;
  systemContext?: string;
  effectivenessScore: number;
  invocationCount: number;
  isActive: boolean;
  abWeight: number;
  evolutionSource: string;
  parentVersion?: number;
  knownDeadEnds: string[];
  highSignalPaths: string[];
}

export interface PromptBuildContext {
  triggerContext: string;
  researchQuestion: string;
  repoList: string;
  dynamicInstructions?: string;
  /**
   * ADR-039 SCOPE-phase fields. Used by the `goal_refinement` trigger
   * template; ignored by every other trigger (substitutions are no-ops
   * when the placeholders don't appear in the template body).
   */
  rawGoal?: string;
  catalogHint?: string;
}

function rowToTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    triggerType: row.trigger_type as TriggerType,
    version: row.version,
    template: row.template,
    systemContext: row.system_context ?? undefined,
    effectivenessScore: row.effectiveness_score,
    invocationCount: row.invocation_count,
    isActive: row.is_active === 1,
    abWeight: row.ab_weight,
    evolutionSource: row.evolution_source,
    parentVersion: row.parent_version ?? undefined,
    knownDeadEnds: row.known_dead_ends ? JSON.parse(row.known_dead_ends) : [],
    highSignalPaths: row.high_signal_paths ? JSON.parse(row.high_signal_paths) : [],
  };
}

export class PromptEvolver {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  selectTemplate(triggerType: TriggerType): PromptTemplate | null {
    const active = getActiveTemplate(this.db, triggerType);
    if (!active) return null;

    const candidates = getABCandidates(this.db, triggerType);
    if (candidates.length === 0) return rowToTemplate(active);

    const rand = Math.random();
    let cumulative = 0;
    for (const candidate of candidates) {
      cumulative += candidate.ab_weight;
      if (rand < cumulative) {
        return rowToTemplate(candidate);
      }
    }

    return rowToTemplate(active);
  }

  async buildPrompt(triggerType: TriggerType, context: PromptBuildContext): Promise<{ prompt: string; templateId: number } | null> {
    const template = this.selectTemplate(triggerType);
    if (!template) return null;

    const exemplars = getExemplars(this.db, triggerType, undefined, 3);
    const fewShotText = exemplars.length > 0
      ? exemplars.map((e, i) => `Example ${i + 1}:\nQ: ${e.input_summary}\nA: ${e.output_summary}`).join('\n\n')
      : 'No past examples yet.';

    const deadEndsText = template.knownDeadEnds.length > 0
      ? template.knownDeadEnds.map(d => `- ${d}`).join('\n')
      : 'None known yet.';

    const highSignalText = template.highSignalPaths.length > 0
      ? template.highSignalPaths.map(p => `- ${p}`).join('\n')
      : 'None identified yet.';

    let prompt = template.template
      .replace('{{trigger_context}}', context.triggerContext)
      .replace('{{research_question}}', context.researchQuestion)
      .replace('{{repo_list}}', context.repoList)
      .replace('{{dynamic_instructions}}', context.dynamicInstructions ?? '')
      .replace('{{few_shot_examples}}', fewShotText)
      .replace('{{known_dead_ends}}', deadEndsText)
      .replace('{{high_signal_paths}}', highSignalText)
      // ADR-039: SCOPE-phase substitutions. Fall back to placeholder text
      // when callers omit the fields so `goal_refinement` callers can't
      // accidentally ship a template with unrendered `{{...}}` brackets.
      // AC-10: catalogHint is non-binding — omitted hint is the safe path.
      .replace('{{raw_goal}}', context.rawGoal ?? '(no raw goal provided)')
      .replace('{{catalog_hint}}', context.catalogHint ?? 'no catalog hint available');

    incrementTemplateInvocations(this.db, template.id);

    return { prompt, templateId: template.id };
  }
}
