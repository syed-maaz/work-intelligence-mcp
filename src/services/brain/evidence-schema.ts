/**
 * U-10 phase 2 — structured brain decision evidence.
 * Stored in brain_decisions.evidence_json; legacy string[] rows normalize on read.
 */

export interface BrainEvidenceRecord {
  source: string;
  source_id: string;
  snippet?: string;
  url?: string;
  timestamp?: string;
}

/** UI / API shape (DecisionCard expects `id`, not `source_id`). */
export interface BrainEvidenceUi {
  source: string;
  id: string;
  note?: string;
  url?: string;
  timestamp?: string;
  count?: number;
}

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;

export function jiraBrowseUrl(key: string): string {
  const domain = process.env.JIRA_DOMAIN ?? 'jira.example.com';
  return `https://${domain}/browse/${key}`;
}

/** Anthropic tool-use schema for emit_decision.evidence */
export const BRAIN_EVIDENCE_TOOL_ITEM = {
  type: 'object' as const,
  properties: {
    source: {
      type: 'string',
      description: 'Evidence source: jira, teams, github, calendar, memory, investigation, or other.',
    },
    source_id: {
      type: 'string',
      description: 'Stable identifier: Jira key (JIRA-123), PR number, chat id, etc.',
    },
    snippet: { type: 'string', description: 'Short human-readable excerpt supporting the decision.' },
    url: { type: 'string', description: 'Direct link when known.' },
    timestamp: { type: 'string', description: 'ISO-8601 or relative time when the evidence was observed.' },
  },
  required: ['source', 'source_id', 'snippet'],
};

function inferFromText(text: string): BrainEvidenceRecord {
  const trimmed = text.trim();
  const jira = trimmed.match(JIRA_KEY_RE);
  if (jira) {
    const key = jira[1];
    return {
      source: 'jira',
      source_id: key,
      snippet: trimmed,
      url: jiraBrowseUrl(key),
    };
  }
  if (/^PR\s*#?\d+/i.test(trimmed) || /\b#\d{2,}\b/.test(trimmed)) {
    const num = trimmed.match(/#?(\d{2,})/);
    return {
      source: 'github',
      source_id: num ? `PR-${num[1]}` : trimmed.slice(0, 32),
      snippet: trimmed,
    };
  }
  if (trimmed.startsWith('http')) {
    return { source: 'url', source_id: trimmed.slice(0, 120), snippet: trimmed, url: trimmed };
  }
  return { source: 'context', source_id: trimmed.slice(0, 64), snippet: trimmed };
}

function coerceRecord(raw: unknown): BrainEvidenceRecord | null {
  if (typeof raw === 'string') return inferFromText(raw);
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const source = typeof o.source === 'string' ? o.source : 'context';
  const source_id =
    typeof o.source_id === 'string'
      ? o.source_id
      : typeof o.id === 'string'
        ? o.id
        : null;
  if (!source_id) return null;
  const rec: BrainEvidenceRecord = { source, source_id };
  if (typeof o.snippet === 'string') rec.snippet = o.snippet;
  else if (typeof o.note === 'string') rec.snippet = o.note;
  if (typeof o.url === 'string') rec.url = o.url;
  if (typeof o.timestamp === 'string') rec.timestamp = o.timestamp;
  if (!rec.url && source === 'jira' && JIRA_KEY_RE.test(source_id)) {
    rec.url = jiraBrowseUrl(source_id);
  }
  return rec;
}

/** Parse evidence_json from SQLite — accepts legacy string[] or structured objects. */
export function parseEvidenceJson(stored: string | null | undefined): BrainEvidenceRecord[] {
  if (!stored) return [];
  try {
    const v = JSON.parse(stored);
    if (!Array.isArray(v)) return [];
    return v.map(coerceRecord).filter((x): x is BrainEvidenceRecord => x !== null);
  } catch {
    return [];
  }
}

/** Coerce model output before persist. */
export function coerceEvidenceForPersist(raw: unknown): BrainEvidenceRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(coerceRecord).filter((x): x is BrainEvidenceRecord => x !== null);
}

export function toUiEvidence(records: BrainEvidenceRecord[]): BrainEvidenceUi[] {
  return records.map((r) => ({
    source: r.source,
    id: r.source_id,
    note: r.snippet,
    url: r.url,
    timestamp: r.timestamp,
  }));
}
