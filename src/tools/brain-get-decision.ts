/**
 * Brain MCP tool: get_decision
 *
 * Thin wrapper around POST /api/brain/decide.
 * Returns a structured decision with rationale, evidence, confidence, and next-action
 * recommendations. Persists to brain_decisions for learning.
 *
 * ADR-024 Pillar 1 — Decision Engine
 */

const BRIDGE_BASE = process.env.WI_BRIDGE_URL ?? 'http://localhost:3132';

export interface GetDecisionArgs {
  question: string;
  user: string;
  context?: Record<string, unknown>;
}

export interface DecisionEvidence {
  source: string;
  id: string;
  count?: number;
  note?: string;
}

export interface DecisionNextAction {
  type: string;
  tool: string;
  args: string;
}

export interface DecisionAlternative {
  decision: string;
  score: number;
}

export interface DecisionResult {
  decision_id: string;
  decision: string;
  rationale: string;
  confidence: number;
  evidence: DecisionEvidence[];
  next_actions: DecisionNextAction[];
  alternatives: DecisionAlternative[];
  cached?: boolean;
}

export async function getBrainDecision(args: GetDecisionArgs): Promise<DecisionResult> {
  const { question, user, context } = args;

  if (!question?.trim()) {
    throw new Error('question is required');
  }
  if (!user?.trim()) {
    throw new Error('user is required');
  }

  const url = `${BRIDGE_BASE}/api/brain/decide`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WI-Consumer': 'mcp',
    },
    body: JSON.stringify({ question, user, context: context ?? {} }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brain decide endpoint returned ${response.status}: ${body}`);
  }

  return response.json() as Promise<DecisionResult>;
}

export function formatDecisionResult(result: DecisionResult): string {
  const lines: string[] = [];

  lines.push(`## Decision`);
  lines.push(`**ID**: ${result.decision_id}${result.cached ? ' *(cached)*' : ''}`);
  lines.push(`\n**Recommendation**: ${result.decision}`);
  lines.push(`**Confidence**: ${(result.confidence * 100).toFixed(0)}%`);
  lines.push(`\n**Rationale**: ${result.rationale}`);

  if (result.evidence?.length) {
    lines.push(`\n**Evidence** (${result.evidence.length}):`);
    for (const e of result.evidence) {
      const count = e.count != null ? ` (×${e.count})` : '';
      const note = e.note ? ` — ${e.note}` : '';
      lines.push(`  - [${e.source}] ${e.id}${count}${note}`);
    }
  }

  if (result.next_actions?.length) {
    lines.push(`\n**Next Actions**:`);
    for (const na of result.next_actions) {
      lines.push(`  - ${na.type}: \`${na.tool}\` → ${na.args}`);
    }
  }

  if (result.alternatives?.length) {
    lines.push(`\n**Alternatives**:`);
    for (const alt of result.alternatives) {
      lines.push(`  - ${alt.decision} (score: ${(alt.score * 100).toFixed(0)}%)`);
    }
  }

  return lines.join('\n');
}
