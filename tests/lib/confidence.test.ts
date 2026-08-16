import { describe, it, expect } from 'vitest';
import { formatConfidence, confidenceTier } from '../../web/src/lib/confidence.js';

describe('formatConfidence (U-4)', () => {
  it('maps high tier at >= 0.8', () => {
    expect(confidenceTier(0.85)).toBe('high');
    const d = formatConfidence(0.85);
    expect(d.label).toBe('High confidence');
    expect(d.tier).toBe('high');
    expect(d.hint).toContain('85%');
  });

  it('maps medium tier between 0.5 and 0.8', () => {
    expect(confidenceTier(0.65)).toBe('medium');
    const d = formatConfidence(0.65);
    expect(d.label).toBe('Medium confidence');
  });

  it('maps low tier below 0.5', () => {
    expect(confidenceTier(0.3)).toBe('low');
    const d = formatConfidence(0.3);
    expect(d.label).toBe('Low confidence');
    expect(d.hint).toContain('hypothesis');
  });

  it('clamps out-of-range values', () => {
    const d = formatConfidence(1.5);
    expect(d.hint).toContain('100%');
  });
});
