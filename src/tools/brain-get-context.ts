/**
 * Brain MCP tool: get_context
 *
 * Thin wrapper around GET /api/brain/context.
 * Returns the 7-field context payload used by all consumers before an LLM turn.
 *
 * ADR-024 Pillar 2 — Context Injector
 */

const BRIDGE_BASE = process.env.WI_BRIDGE_URL ?? 'http://localhost:3132';

export interface GetContextArgs {
  /** Intentionally empty — context is always for the current user / bridge state */
  _?: never;
}

export interface BrainContextResult {
  sprint: {
    name: string;
    ends: string;
    fresh: boolean;
  };
  stuck_jiras: Array<{
    key: string;
    days_stuck: number;
    cluster: string;
  }>;
  noise_clusters: Array<{
    signature: string;
    count: number;
    actionable_root: string;
  }>;
  calendar_today: Array<{
    time: string;
    title: string;
    with: string;
  }>;
  open_investigations: Array<{
    key: string;
    status: string;
  }>;
  memory_relevant: string[];
  stale_warnings: string[];
}

export async function getBrainContext(
  _args: GetContextArgs = {}
): Promise<BrainContextResult> {
  const url = `${BRIDGE_BASE}/api/brain/context`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-WI-Consumer': 'mcp',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brain context endpoint returned ${response.status}: ${body}`);
  }

  return response.json() as Promise<BrainContextResult>;
}

export function formatBrainContext(result: BrainContextResult): string {
  const lines: string[] = ['## Work Intelligence Context\n'];

  // Sprint
  const sprint = result.sprint;
  if (sprint?.name) {
    const freshFlag = sprint.fresh ? '' : ' ⚠ STALE';
    lines.push(`**Sprint**: ${sprint.name} — ends ${sprint.ends}${freshFlag}`);
  }

  // Stuck Jiras
  if (result.stuck_jiras?.length) {
    lines.push(`\n**Stuck Jiras** (${result.stuck_jiras.length}):`);
    for (const j of result.stuck_jiras) {
      lines.push(`  - ${j.key}: ${j.days_stuck} days stuck (cluster: ${j.cluster})`);
    }
  }

  // Noise clusters
  if (result.noise_clusters?.length) {
    lines.push(`\n**Noise Clusters** (${result.noise_clusters.length}):`);
    for (const c of result.noise_clusters) {
      lines.push(`  - ${c.signature}: ${c.count} occurrences → ${c.actionable_root}`);
    }
  }

  // Calendar
  if (result.calendar_today?.length) {
    lines.push(`\n**Today's Calendar** (${result.calendar_today.length} events):`);
    for (const e of result.calendar_today) {
      lines.push(`  - ${e.time}: ${e.title} with ${e.with}`);
    }
  }

  // Open investigations
  if (result.open_investigations?.length) {
    lines.push(`\n**Open Investigations** (${result.open_investigations.length}):`);
    for (const inv of result.open_investigations) {
      lines.push(`  - ${inv.key}: ${inv.status}`);
    }
  }

  // Memory
  if (result.memory_relevant?.length) {
    lines.push(`\n**Relevant Memory**:`);
    for (const m of result.memory_relevant) {
      lines.push(`  - ${m}`);
    }
  }

  // Stale warnings
  if (result.stale_warnings?.length) {
    lines.push(`\n**Stale Warnings**:`);
    for (const w of result.stale_warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join('\n');
}
