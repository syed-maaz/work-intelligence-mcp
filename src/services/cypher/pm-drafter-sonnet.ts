/**
 * Sonnet-backed PM plan drafter for ADR-053.
 *
 * Uses Anthropic messages.create with the 'pm' bucket from model-config to
 * draft a JSON DAG plan, then normalizes it via parsePlanFromText.
 */
import type Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { bucketCallParams } from '../model-config.js';
import type { HydratedBrief, PlanDraft } from './pm-templates/index.js';
import { parsePlanFromText } from './pm-drafter.js';

function buildSystemPrompt(): string {
  return [
    'You are the PM orchestrator for a cross-repo software feature.',
    'Decompose the goal into a DAG of sub-tasks across the affected repos.',
    'Postures: "fe" (web/frontend), "be" (backend/API), "ops" (operations/deploy), "generic".',
    'Rules: if operations is an affected repo, include an "ops" sub-task that depends on the code sub-tasks.',
    'Keep it minimal (3-6 nodes). No cycles. Every depends_on id must reference another sub_task id.',
    'Respond with ONLY a JSON object, no prose:',
    '{"sub_tasks":[{"id":"be","title":"...","posture":"be","depends_on":[]},{"id":"fe","title":"...","posture":"fe","depends_on":["be"]}]}'
  ].join('\n');
}

function buildUserPrompt(brief: HydratedBrief, reviseNotes?: string[]): string {
  const lines = [
    `Goal: ${brief.goal}`,
    `Intent: ${brief.intent}`,
    `Target: ${brief.target}`,
    `Affected repos: ${brief.affected_repos.join(', ') || '(none detected)'}`,
  ];
  if (reviseNotes && reviseNotes.length > 0) {
    lines.push('', 'Architect asked you to revise the previous plan. Address these notes:');
    for (const n of reviseNotes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

export async function draftPlanViaSonnet(
  db: Database.Database,
  brief: HydratedBrief,
  reviseNotes?: string[],
): Promise<PlanDraft> {
  const params = bucketCallParams(db, 'pm');
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    // Support custom base if configured
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  });
  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(brief, reviseNotes);
  // Simpler contract: collapse system+user into one user message to avoid
  // SDK type issues around role:'system' blocks in this codepath.
  const resp = await client.messages.create({
    ...params,
    messages: [
      { role: 'user', content: `${sys}\n\n${usr}` },
    ],
  } as any);
  // Coalesce assistant text content
  const contentText = (resp.content || [])
    .map((b: any) => (b && b.type === 'text' ? String(b.text || '') : ''))
    .join('\n');
  return parsePlanFromText(contentText);
}

export default draftPlanViaSonnet;
