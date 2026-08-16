/**
 * Brain MCP tool: recall_memory
 *
 * Thin wrapper around POST /api/brain/recall.
 * Queries the palace + SQLite decision history for past patterns
 * ranked by recency × confidence. Answers "have we seen this before?"
 *
 * ADR-024 Pillar 4 — Memory Decision Loop (recall side)
 */

const BRIDGE_BASE = process.env.WI_BRIDGE_URL ?? 'http://localhost:3132';

export interface RecallMemoryArgs {
  query: string;
  limit?: number;
}

export interface RecallEntry {
  id: string;
  type: 'decision' | 'palace' | 'investigation';
  summary: string;
  score: number;
  created_at?: string;
  outcome?: string;
}

export interface RecallResult {
  query: string;
  entries: RecallEntry[];
  total: number;
}

export async function recallBrainMemory(args: RecallMemoryArgs): Promise<RecallResult> {
  const { query, limit = 10 } = args;

  if (!query?.trim()) {
    throw new Error('query is required');
  }

  const url = `${BRIDGE_BASE}/api/brain/recall`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WI-Consumer': 'mcp',
    },
    body: JSON.stringify({ query, limit }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brain recall endpoint returned ${response.status}: ${body}`);
  }

  return response.json() as Promise<RecallResult>;
}

export function formatRecallResult(result: RecallResult): string {
  const lines: string[] = [];

  lines.push(`## Memory Recall: "${result.query}"`);
  lines.push(`Found ${result.total} matching entries.\n`);

  if (!result.entries?.length) {
    lines.push('No relevant memories found for this query.');
    return lines.join('\n');
  }

  for (const [i, entry] of result.entries.entries()) {
    const outcomeNote = entry.outcome ? ` [${entry.outcome}]` : '';
    const dateNote = entry.created_at ? ` — ${entry.created_at}` : '';
    lines.push(`**${i + 1}. [${entry.type}]** score: ${(entry.score * 100).toFixed(0)}%${outcomeNote}${dateNote}`);
    lines.push(`   ${entry.summary}`);
    lines.push('');
  }

  return lines.join('\n');
}
