/**
 * Brain MCP tool: verify_claim
 *
 * Thin wrapper around POST /api/brain/verify.
 * Turns a claim into a verified fact using available adapters
 * (GitHub MCP, Jira MCP, code grep, build logs).
 *
 * ADR-024 Pillar 3 — Verification Layer
 */

const BRIDGE_BASE = process.env.WI_BRIDGE_URL ?? 'http://localhost:3132';

export interface VerifyClaimArgs {
  claim: string;
  evidence_needed?: string[];
}

export interface VerificationResult {
  id?: string;
  claim: string;
  verified: boolean;
  evidence: string;
  confidence: number;
  checked_at: string;
  adapter_results?: Array<{
    adapter: string;
    result: unknown;
    error?: string;
  }>;
}

export async function verifyBrainClaim(args: VerifyClaimArgs): Promise<VerificationResult> {
  const { claim, evidence_needed } = args;

  if (!claim?.trim()) {
    throw new Error('claim is required');
  }

  const url = `${BRIDGE_BASE}/api/brain/verify`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WI-Consumer': 'mcp',
    },
    body: JSON.stringify({ claim, evidence_needed: evidence_needed ?? [] }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brain verify endpoint returned ${response.status}: ${body}`);
  }

  return response.json() as Promise<VerificationResult>;
}

export function formatVerificationResult(result: VerificationResult): string {
  const lines: string[] = [];

  const status = result.verified ? 'VERIFIED' : 'NOT VERIFIED';
  lines.push(`## Claim Verification: ${status}`);
  lines.push(`**Claim**: ${result.claim}`);
  lines.push(`**Confidence**: ${(result.confidence * 100).toFixed(0)}%`);
  lines.push(`**Checked at**: ${result.checked_at}`);

  if (result.evidence) {
    lines.push(`\n**Evidence**: ${result.evidence}`);
  }

  if (result.adapter_results?.length) {
    lines.push(`\n**Adapter Results**:`);
    for (const ar of result.adapter_results) {
      const errNote = ar.error ? ` ⚠ error: ${ar.error}` : '';
      lines.push(`  - [${ar.adapter}]: ${JSON.stringify(ar.result)}${errNote}`);
    }
  }

  return lines.join('\n');
}
