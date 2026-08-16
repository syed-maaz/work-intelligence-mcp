/**
 * Brain MCP tool: record_outcome
 *
 * Thin wrapper around POST /api/brain/learn.
 * Records the outcome of a previously made decision
 * ('success' | 'failed' | 'abandoned'), closes the learning loop,
 * and updates palace via MemoryEnricher's decisions wing.
 *
 * ADR-024 Pillar 4 — Memory Decision Loop (learn side)
 */

const BRIDGE_BASE = process.env.WI_BRIDGE_URL ?? 'http://localhost:3132';

export type DecisionOutcome = 'success' | 'failed' | 'abandoned';

export interface RecordOutcomeArgs {
  decision_id: string;
  outcome: DecisionOutcome;
  notes?: string;
}

export interface LearnResult {
  decision_id: string;
  outcome: DecisionOutcome;
  outcome_recorded_at: string;
  palace_updated: boolean;
}

export async function recordBrainOutcome(args: RecordOutcomeArgs): Promise<LearnResult> {
  const { decision_id, outcome, notes } = args;

  if (!decision_id?.trim()) {
    throw new Error('decision_id is required');
  }
  if (!outcome || !['success', 'failed', 'abandoned'].includes(outcome)) {
    throw new Error('outcome must be one of: success, failed, abandoned');
  }

  const url = `${BRIDGE_BASE}/api/brain/learn`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WI-Consumer': 'mcp',
    },
    body: JSON.stringify({ decision_id, outcome, notes }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brain learn endpoint returned ${response.status}: ${body}`);
  }

  return response.json() as Promise<LearnResult>;
}

export function formatLearnResult(result: LearnResult): string {
  const lines: string[] = [];

  const statusIcon = result.outcome === 'success' ? 'SUCCESS' :
                     result.outcome === 'failed' ? 'FAILED' : 'ABANDONED';

  lines.push(`## Outcome Recorded: ${statusIcon}`);
  lines.push(`**Decision ID**: ${result.decision_id}`);
  lines.push(`**Outcome**: ${result.outcome}`);
  lines.push(`**Recorded at**: ${result.outcome_recorded_at}`);
  lines.push(`**Palace updated**: ${result.palace_updated ? 'yes' : 'no'}`);

  return lines.join('\n');
}
