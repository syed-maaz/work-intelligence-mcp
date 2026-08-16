/**
 * ADR-053 Phase 2 — PM plan drafter (the LLM half of step 2).
 *
 * The PM orchestrator's step 2 ("LLM drafts a DAG of sub-tasks") is injected
 * as `PmDeps.draftPlan`. This module provides a concrete drafter backed by a
 * local Ollama-compatible endpoint (default gemma4 via http://localhost:11434),
 * so the PM tier can run end-to-end WITHOUT the hosted-Opus rate limit. The
 * hosted-model drafter can be swapped in later by providing a different
 * draftPlan to runPmOrchestrator — the orchestrator doesn't care which.
 *
 * Output contract: the model must return a JSON object
 *   { "sub_tasks": [ { "id", "title", "posture": fe|be|ops|generic, "depends_on": [ids] } ] }
 * parsePlanFromText tolerates a ```json fence, raw JSON, missing depends_on
 * (→ []), and unknown posture (→ 'generic'). The template validator + Kahn
 * check downstream catch structural problems, so the drafter stays permissive.
 */
import type { PlanDraft, PlanSubTask, HydratedBrief, SubTaskPosture } from './pm-templates/index.js';

const VALID_POSTURES: SubTaskPosture[] = ['fe', 'be', 'ops', 'generic'];

function ollamaChatUrl(): string {
  const base = process.env.LLAMA_ENDPOINT_URL || 'http://localhost:11434/api/chat';
  return base;
}

/** Extract + normalize a PlanDraft from raw model text. Throws if no JSON found. */
export function parsePlanFromText(text: string): PlanDraft {
  let jsonStr: string | undefined;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    jsonStr = fence[1].trim();
  } else {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) jsonStr = text.slice(first, last + 1);
  }
  if (!jsonStr) throw new Error('pm-drafter: no JSON plan found in model output');

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`pm-drafter: failed to parse plan JSON: ${(e as Error).message}`);
  }

  const rawTasks = (parsed as { sub_tasks?: unknown }).sub_tasks;
  if (!Array.isArray(rawTasks)) {
    throw new Error('pm-drafter: parsed plan has no sub_tasks array');
  }

  const sub_tasks: PlanSubTask[] = rawTasks.map((t, i) => {
    const obj = (t ?? {}) as Record<string, unknown>;
    const posture = String(obj.posture ?? 'generic') as SubTaskPosture;
    return {
      id: String(obj.id ?? `t${i}`),
      title: String(obj.title ?? `Sub-task ${i}`),
      posture: VALID_POSTURES.includes(posture) ? posture : 'generic',
      depends_on: Array.isArray(obj.depends_on) ? obj.depends_on.map((d) => String(d)) : [],
    };
  });

  return { sub_tasks };
}

function buildSystemPrompt(): string {
  return [
    'You are the PM orchestrator for a cross-repo software feature.',
    'Decompose the goal into a DAG of sub-tasks across the affected repos.',
    'Postures: "fe" (web/frontend), "be" (backend/API), "ops" (operations/deploy), "generic".',
    'Rules: if operations is an affected repo, include an "ops" sub-task that depends on the code sub-tasks.',
    'Keep it minimal (3-6 nodes). No cycles. Every depends_on id must reference another sub_task id.',
    'Respond with ONLY a JSON object, no prose:',
    '{"sub_tasks":[{"id":"be","title":"...","posture":"be","depends_on":[]},{"id":"fe","title":"...","posture":"fe","depends_on":["be"]}]}',
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

export interface DraftOptions {
  model?: string;
  timeoutMs?: number;
}

/**
 * Draft a plan via the local Ollama endpoint. Returns a normalized PlanDraft.
 * Throws on transport error or unparseable output (the orchestrator's
 * retry-on-structural-failure loop handles re-drafting).
 */
export async function draftPlanViaLLM(
  brief: HydratedBrief,
  reviseNotes?: string[],
  opts: DraftOptions = {},
): Promise<PlanDraft> {
  const model = opts.model || process.env.PM_DRAFTER_MODEL || 'gemma4:26b';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(ollamaChatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(brief, reviseNotes) },
        ],
        stream: false,
        options: { temperature: 0.2, num_predict: 800 },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`pm-drafter: Ollama HTTP ${resp.status}`);
    const data = (await resp.json()) as { message?: { content?: string } };
    const content = data.message?.content ?? '';
    return parsePlanFromText(content);
  } finally {
    clearTimeout(timer);
  }
}

export default draftPlanViaLLM;
