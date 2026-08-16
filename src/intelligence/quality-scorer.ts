import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { recordOutcome, insertExemplar } from '../db/queries/research-cache.js';
import { runOPRO, runTextGradRepair, checkABPromotion } from './prompt-evolution-jobs.js';
import type { ClaudeCodeResult } from '../services/claude-code-runner.js';
import type { TriggerType } from './cost-gate.js';
import { bucketCallParams } from '../services/model-config.js';

export interface QualityScore {
  relevance: number;
  depth: number;
  actionability: number;
  combined: number;
}

/**
 * ADR-039 SCOPE-phase output shape. Mirrors the JSON schema documented
 * in `goal_refinement` seed (prompt-seeds.ts). Used by
 * `QualityScorer.scoreRefinedGoal()` to score the brief itself rather
 * than findings — and by `loop.ts` when persisting to
 * `cypher_sessions.refined_goal`.
 */
export interface RefinedGoalArtifact {
  intent: string;
  target: string;
  constraints: string[];
  success_criteria: string[];
  out_of_scope: string[];
  linkage: { tickets: string[]; prs: string[]; files: string[] };
  expected_output_shape: string;
  evidence_cited: string[];
}

export interface ScoreRefinedGoalInput {
  rawGoal: string;
  refinedGoal: RefinedGoalArtifact;
  templateId: number;
  researchId?: number;
  tokensUsed?: number;
  costUsd?: number;
  latencyMs?: number;
  /**
   * ADR-039 AC-19 (2026-06-29): cypher_sessions.session_id of the
   * dispatch that produced this refined_goal. Threaded through to
   * the prompt_outcomes INSERT (via v88 column) so AC-19 dogfood
   * SQL can join refinement-enabled dispatches to their verdicts.
   * Optional — legacy `score()` callers leave it undefined.
   */
  sessionId?: string;
}

const SCORER_SYSTEM = 'You are a quality evaluator for AI-generated code research. Score outputs on three dimensions.';
const REFINER_SCORER_SYSTEM = 'You are a quality evaluator for Cypher\'s scope phase. The output you are scoring is a structured brief — a refined_goal — produced by the SCOPE half of a two-pass loop (ADR-039). Score how well it disambiguates the required fields for a downstream EXECUTE phase, not whether it solves the problem.';

export class QualityScorer {
  private apiKey: string;
  private db: Database.Database;

  constructor(apiKey: string, db: Database.Database) {
    this.apiKey = apiKey;
    this.db = db;
  }

  private makeClient(): Anthropic {
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    return new Anthropic({
      apiKey: baseURL ? 'x-proxy' : this.apiKey,
      ...(baseURL ? {
        baseURL,
        defaultHeaders: { Authorization: `Bearer ${this.apiKey}` },
      } : {}),
    });
  }

  async score(
    result: ClaudeCodeResult,
    templateId: number,
    triggerInput: string,
    researchId?: number,
    triggerType: TriggerType = 'jira_analyze',
  ): Promise<QualityScore | null> {
    // ADR-039 AC-12: when scoring a goal_refinement output, the
    // "findings" array actually carries the refined_goal brief as
    // findings[0].explanation (JSON). Branch to scoreRefinedGoal()
    // which uses the SCOPE-phase rubric and writes the same
    // prompt_outcomes row shape.
    if (triggerType === 'goal_refinement') {
      const explanation = result.findings[0]?.explanation ?? '';
      let parsed: RefinedGoalArtifact | null = null;
      try {
        parsed = JSON.parse(explanation) as RefinedGoalArtifact;
      } catch {
        parsed = null;
      }

      // Fallback path: the worker emitted prose instead of JSON. We
      // still want to score so OPRO can learn the brief is malformed,
      // but the rubric prompt carries the raw text not the parsed object.
      return this.scoreRefinedGoalInternal({
        rawGoal: triggerInput,
        refinedGoal: parsed,
        rawBrief: parsed ? null : explanation,
        templateId,
        researchId,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        latencyMs: result.durationMs,
        triggerType: 'goal_refinement',
      });
    }

    const client = this.makeClient();
    const bucketParams = bucketCallParams(this.db, 'fetch', 128);

    const findingsSummary = result.findings
      .map(f => `- ${f.title}: ${f.explanation.slice(0, 200)}`)
      .join('\n');

    const prompt = `Score this code research output on three quality dimensions (0.0-1.0 each):

## Research Question
${triggerInput}

## Research Output (${result.findings.length} findings)
${findingsSummary}

## Files Examined
${result.filesExamined.slice(0, 10).join(', ')}

## Scoring Criteria
- Relevance (weight 0.4): Does the output directly address the question?
- Depth (weight 0.3): Does it go beyond grep — traces chains, explains WHY?
- Actionability (weight 0.3): Could a developer act immediately on these findings?`;

    try {
      const response = await client.beta.promptCaching.messages.create({
        ...bucketParams,
        temperature: 0,
        system: [{ type: 'text', text: SCORER_SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [
          {
            name: 'quality_score',
            description: 'Score code research output quality',
            input_schema: {
              type: 'object' as const,
              properties: {
                relevance: { type: 'number', description: '0.0-1.0 relevance score' },
                depth: { type: 'number', description: '0.0-1.0 depth score' },
                actionability: { type: 'number', description: '0.0-1.0 actionability score' },
              },
              required: ['relevance', 'depth', 'actionability'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'quality_score' },
        messages: [{ role: 'user', content: prompt }],
      });

      const block = response.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') return null;

      const scores = block.input as { relevance: number; depth: number; actionability: number };
      const combined = scores.relevance * 0.4 + scores.depth * 0.3 + scores.actionability * 0.3;

      const qualityScore: QualityScore = {
        relevance: scores.relevance,
        depth: scores.depth,
        actionability: scores.actionability,
        combined,
      };

      recordOutcome(this.db, {
        templateId,
        researchId: researchId ?? null,
        triggerInput,
        qualityScore: combined,
        relevanceScore: scores.relevance,
        depthScore: scores.depth,
        actionabilityScore: scores.actionability,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        latencyMs: result.durationMs,
      });

      if (combined > 0.8 && result.findings.length > 0) {
        insertExemplar(this.db, {
          triggerType,
          repo: result.filesExamined[0]?.split('/')[0] ?? 'unknown',
          area: result.findings[0].relevantFiles[0] ?? null,
          inputSummary: triggerInput.slice(0, 200),
          outputSummary: result.findings.map(f => f.title).join('; ').slice(0, 300),
          qualityScore: combined,
        });
      }

      // EP-67 Wave 4: Evolution triggers (all fire-and-forget)
      const invCount = this.db.prepare('SELECT invocation_count FROM prompt_templates WHERE id = ?').get(templateId) as { invocation_count: number } | undefined;
      if (invCount && invCount.invocation_count % 20 === 0) {
        runOPRO(this.db, triggerType, this.apiKey).catch(() => {});
      }
      if (combined < 0.3) {
        const lastOutcome = this.db.prepare('SELECT id FROM prompt_outcomes ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
        if (lastOutcome) {
          runTextGradRepair(this.db, lastOutcome.id, this.apiKey).catch(() => {});
        }
      }
      checkABPromotion(this.db, triggerType);

      return qualityScore;
    } catch {
      return null;
    }
  }

  /**
   * ADR-039 AC-12 entrypoint — score a refined_goal brief directly
   * (callable from `loop.ts` after the SCOPE phase persists its output
   * to `cypher_sessions.refined_goal`). The rubric is re-anchored to
   * SCOPE-phase axes: does the brief disambiguate the required fields,
   * is it grounded in evidence, can the EXECUTE phase act on it
   * without re-asking?
   */
  async scoreRefinedGoal(input: ScoreRefinedGoalInput): Promise<QualityScore | null> {
    return this.scoreRefinedGoalInternal({
      ...input,
      rawBrief: null,
      triggerType: 'goal_refinement',
    });
  }

  private async scoreRefinedGoalInternal(args: {
    rawGoal: string;
    refinedGoal: RefinedGoalArtifact | null;
    rawBrief: string | null;
    templateId: number;
    researchId?: number;
    tokensUsed?: number;
    costUsd?: number;
    latencyMs?: number;
    triggerType: TriggerType;
    sessionId?: string;
  }): Promise<QualityScore | null> {
    const client = this.makeClient();
    const bucketParams = bucketCallParams(this.db, 'fetch', 128);

    const briefForPrompt = args.refinedGoal
      ? JSON.stringify(args.refinedGoal, null, 2)
      : (args.rawBrief ?? '(no brief produced)');

    const prompt = `Score this goal-refinement brief on three quality dimensions (0.0-1.0 each):

## Raw user goal
${args.rawGoal}

## Refined brief (the SCOPE phase output under review)
${briefForPrompt}

## Scoring Criteria (re-anchored for the SCOPE phase)
- Relevance (weight 0.4): Does the brief disambiguate the required fields the EXECUTE phase will read (intent, target, success_criteria, out_of_scope, linkage)? A relevant brief leaves no ambiguity about WHAT the user asked for.
- Depth (weight 0.3): Is evidence_cited grounded in real files/tickets/lines, and do constraints/out_of_scope reflect serious thought rather than empty arrays?
- Actionability (weight 0.3): Could the execute phase act on this brief without re-asking the user a single question? Specifically, are success_criteria observable and is expected_output_shape pickable?`;

    try {
      const response = await client.beta.promptCaching.messages.create({
        ...bucketParams,
        temperature: 0,
        system: [{ type: 'text', text: REFINER_SCORER_SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [
          {
            name: 'quality_score',
            description: 'Score refined_goal brief quality',
            input_schema: {
              type: 'object' as const,
              properties: {
                relevance: { type: 'number', description: '0.0-1.0 relevance score' },
                depth: { type: 'number', description: '0.0-1.0 depth score' },
                actionability: { type: 'number', description: '0.0-1.0 actionability score' },
              },
              required: ['relevance', 'depth', 'actionability'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'quality_score' },
        messages: [{ role: 'user', content: prompt }],
      });

      const block = response.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') return null;

      const scores = block.input as { relevance: number; depth: number; actionability: number };
      const combined = scores.relevance * 0.4 + scores.depth * 0.3 + scores.actionability * 0.3;

      const qualityScore: QualityScore = {
        relevance: scores.relevance,
        depth: scores.depth,
        actionability: scores.actionability,
        combined,
      };

      recordOutcome(this.db, {
        templateId: args.templateId,
        researchId: args.researchId ?? null,
        triggerInput: args.rawGoal,
        qualityScore: combined,
        relevanceScore: scores.relevance,
        depthScore: scores.depth,
        actionabilityScore: scores.actionability,
        tokensUsed: args.tokensUsed ?? 0,
        costUsd: args.costUsd ?? 0,
        latencyMs: args.latencyMs ?? 0,
        // ADR-039 AC-19: link back to the cypher_sessions dispatch
        // when one was supplied (refinement-enabled dispatches do;
        // legacy single-pass triggers don't).
        sessionId: args.sessionId ?? null,
      });

      // OPRO + A/B promotion still fire — the goal_refinement trigger
      // participates in the same nightly evolution sweep as other triggers
      // per ADR-039 AC-13.
      const invCount = this.db.prepare('SELECT invocation_count FROM prompt_templates WHERE id = ?').get(args.templateId) as { invocation_count: number } | undefined;
      if (invCount && invCount.invocation_count % 20 === 0) {
        runOPRO(this.db, args.triggerType, this.apiKey).catch(() => {});
      }
      if (combined < 0.3) {
        const lastOutcome = this.db.prepare('SELECT id FROM prompt_outcomes ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
        if (lastOutcome) {
          runTextGradRepair(this.db, lastOutcome.id, this.apiKey).catch(() => {});
        }
      }
      checkABPromotion(this.db, args.triggerType);

      return qualityScore;
    } catch {
      return null;
    }
  }
}
