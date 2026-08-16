/**
 * U-4 — Human-readable confidence labels instead of raw 0.72 numbers.
 */

export type ConfidenceTier = 'high' | 'medium' | 'low';

export interface ConfidenceDisplay {
  tier: ConfidenceTier;
  label: string;
  hint: string;
  color: string;
}

export function confidenceTier(value: number): ConfidenceTier {
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}

export function formatConfidence(value: number): ConfidenceDisplay {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const tier = confidenceTier(value);
  if (tier === 'high') {
    return {
      tier,
      label: 'High confidence',
      hint: `${pct}% — strong signal; treat as actionable unless contradicted by fresh data.`,
      color: 'var(--accent)',
    };
  }
  if (tier === 'medium') {
    return {
      tier,
      label: 'Medium confidence',
      hint: `${pct}% — likely correct; verify manually before acting.`,
      color: '#f59e0b',
    };
  }
  return {
    tier,
    label: 'Low confidence',
    hint: `${pct}% — hypothesis only; gather more evidence before committing.`,
    color: 'var(--danger)',
  };
}
