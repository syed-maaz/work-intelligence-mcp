import { describe, it, expect } from 'vitest';
import {
  parseEvidenceJson,
  coerceEvidenceForPersist,
  toUiEvidence,
  jiraBrowseUrl,
} from '../../src/services/brain/evidence-schema.js';

describe('evidence-schema (U-10)', () => {
  it('normalizes legacy string array from DB', () => {
    const stored = JSON.stringify(['blocker DEMO-16032 closed', 'CI green for 24h']);
    const rows = parseEvidenceJson(stored);
    expect(rows).toHaveLength(2);
    expect(rows[0].source).toBe('jira');
    expect(rows[0].source_id).toBe('DEMO-16032');
    expect(rows[0].url).toBe(jiraBrowseUrl('DEMO-16032'));
  });

  it('round-trips structured objects', () => {
    const input = [
      {
        source: 'teams',
        source_id: 'chat-ops',
        snippet: 'Thread confirms outage',
        timestamp: '2026-05-21T10:00:00Z',
      },
    ];
    const persisted = coerceEvidenceForPersist(input);
    const parsed = parseEvidenceJson(JSON.stringify(persisted));
    expect(parsed[0].source_id).toBe('chat-ops');
    const ui = toUiEvidence(parsed);
    expect(ui[0].id).toBe('chat-ops');
    expect(ui[0].note).toContain('outage');
  });
});
