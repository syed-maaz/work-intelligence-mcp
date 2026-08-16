/**
 * PM-4: auto-link Cypher sessions and commits to work_items via goal-text
 * regex extraction.
 *
 * Extracts AC-shaped tokens from goal text (and optional context) and
 * filters them against the live `work_items` table — only ids that
 * actually exist are surfaced as suggestions. Surfaced ids attach to
 * the dispatch response so /wi can show "this session looks related to
 * X, Y, Z" and the user can correct via /wi-record-outcome --ac.
 *
 * Design notes:
 *   - Pure: takes a string, returns suggestions. No HTTP, no side effects.
 *   - DB-aware filter: regex finds candidates; DB filter rejects unknowns.
 *     Goals routinely mention Jira ticket numbers that aren't (yet)
 *     mirrored into work_items — surfacing those as link suggestions
 *     would create dead evidence rows.
 *   - Confidence ranking: id-prefix patterns (PERSONA-AC-N, CYPHER-*,
 *     PM-N, PHASE-NN-*) score higher than bare numeric (Jira keys)
 *     because the former match the work_items.id namespace exactly.
 *
 * Hard rule 7: this module reads work_items via the PM lens
 * (src/services/cypher/pm.ts). It MUST NOT touch the table directly.
 */

import type Database from 'better-sqlite3';
import { getWorkItem } from './pm.js';

/** A single auto-link candidate surfaced from goal/context text. */
export interface AutoLinkSuggestion {
  /** The work_item.id — confirmed to exist when `exists` is true. */
  id: string;
  /** Confidence score in [0, 1]. Prefix-namespaced ids → 1.0; raw → 0.5. */
  confidence: number;
  /** Char span [start, end) in the source text where this id was found. */
  span: [number, number];
  /** The exact substring that matched. Useful for the dispatch card. */
  matched_text: string;
  /** True iff `id` resolves to a row in work_items. */
  exists: boolean;
}

/**
 * Extraction patterns. Order matters: more specific patterns first so
 * shorter raw matches don't shadow them. Each pattern's name is for
 * trace/debug; the captured id is what goes into the suggestion.
 *
 * Note: we use `\b` boundaries on both sides so e.g. "JIRA-15702-followup"
 * doesn't get extracted as "JIRA-15702" — same for hyphen-trailing tokens.
 *
 * The regex for `PHASE-NN-...` deliberately does not require a numeric
 * suffix because Phase ids in work_items are like `PHASE-77a-01` —
 * mixed alnum after the dash.
 */
const PATTERNS: Array<{ name: string; regex: RegExp; confidence: number }> = [
  { name: 'persona_ac', regex: /\bPERSONA-AC-\d+\b/g, confidence: 1.0 },
  { name: 'cypher_slice', regex: /\bCYPHER-(?:SLICE-[A-Z0-9+]+|NEXT-[A-Z]+|[A-Z][A-Z0-9_-]*)\b/g, confidence: 1.0 },
  { name: 'pm_slice', regex: /\bPM-(?:\d+(?:-PRIME-[A-Z])?|\d+\.\d+|[A-Z][A-Z0-9_-]*)\b/g, confidence: 1.0 },
  { name: 'phase_id', regex: /\bPHASE-\d+[A-Za-z0-9_-]*\b/g, confidence: 0.9 },
  { name: 'jira_key', regex: /\b[A-Z][A-Z0-9_]+-\d+\b/g, confidence: 0.5 },
];

/**
 * Run all patterns over `text` and return raw candidates (one per match,
 * deduped on (id, span)). Confidence comes from the pattern that matched.
 *
 * Edge case: a JIRA-key pattern would match e.g. `PERSONA-AC-2` because
 * `[A-Z][A-Z0-9_]+-\d+` is a superset. We dedupe on `id` AFTER running
 * all patterns, keeping the FIRST seen (highest-confidence by pattern
 * order) — so persona_ac wins over jira_key for the same span.
 */
function extractCandidates(text: string): Omit<AutoLinkSuggestion, 'exists'>[] {
  const seen = new Map<string, Omit<AutoLinkSuggestion, 'exists'>>();
  for (const p of PATTERNS) {
    // Reset regex lastIndex for safety — these are module-level globals.
    p.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.regex.exec(text)) !== null) {
      const id = m[0];
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        confidence: p.confidence,
        span: [m.index, m.index + id.length],
        matched_text: id,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Public entry point: extract auto-link suggestions from a goal+context
 * payload, filter against the live work_items table, and return suggestions.
 *
 * @param db live database handle
 * @param goal goal text from the dispatch payload
 * @param context optional context string (often JSON; we scan it as text)
 * @returns suggestions sorted by confidence desc, then by first-seen order
 */
export function suggestAutoLinks(
  db: Database.Database,
  goal: string,
  context?: string,
): AutoLinkSuggestion[] {
  const haystack = context ? `${goal}\n${context}` : goal;
  const candidates = extractCandidates(haystack);

  // Filter against work_items via the PM lens helper. Hard rule 7 satisfied.
  const suggestions: AutoLinkSuggestion[] = [];
  for (const c of candidates) {
    const item = getWorkItem(db, c.id);
    suggestions.push({ ...c, exists: !!item });
  }

  // Stable sort: existing rows first, then by confidence desc, then by span.
  suggestions.sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.span[0] - b.span[0];
  });
  return suggestions;
}

/**
 * Convenience: just the work_item ids that actually exist, in suggestion
 * order. The dispatch card displays this list to the user; non-existent
 * candidates are surfaced separately (or not at all) so they don't
 * pretend to be link targets.
 */
export function existingLinks(suggestions: AutoLinkSuggestion[]): string[] {
  return suggestions.filter(s => s.exists).map(s => s.id);
}
