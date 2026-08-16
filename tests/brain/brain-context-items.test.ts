import { describe, it, expect } from 'vitest';
import {
  brainContextToContextItems,
  formatBrainContextForPrompt,
} from '../../src/services/brain/brain-context-items.js';
import type { BrainContext } from '../../src/services/brain/context-builder.js';

const sampleCtx: BrainContext = {
  sprint: { name: 'Sprint 93', ends: '2026-06-01', fresh: true },
  stuck_jiras: [{ key: 'DEMO-1', days_stuck: 4, cluster: null }],
  noise_clusters: [],
  calendar_today: [],
  open_investigations: [],
  memory_relevant: ['[decision] dec_X: prior fix (score 0.80)'],
  stale_warnings: [],
};

describe('brainContextToContextItems', () => {
  it('includes operational and memory items', () => {
    const items = brainContextToContextItems(sampleCtx);
    expect(items.length).toBe(2);
    expect(items[0].source).toBe('brain');
    expect(items[0].content).toContain('Sprint 93');
    expect(items[1].source).toBe('brain-memory');
    expect(items[1].content).toContain('dec_X');
  });
});

describe('formatBrainContextForPrompt', () => {
  it('formats sprint and stuck jiras', () => {
    const text = formatBrainContextForPrompt(sampleCtx);
    expect(text).toContain('Sprint 93');
    expect(text).toContain('DEMO-1');
    expect(text).toContain('Recalled memory');
  });
});
