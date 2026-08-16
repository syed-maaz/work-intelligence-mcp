import type Database from 'better-sqlite3';
import type { InvestigationReport } from './investigation-orchestrator.js';
import { defaultRepoName } from './repo-names.js';

// ---------------------------------------------------------------------------
// Pattern Extractor — Phase 55 Wave 5
// Extracts reusable bug patterns from concluded investigations and saves them
// to codebase_knowledge for cross-session reuse.
// ---------------------------------------------------------------------------

/**
 * Extract a bug pattern from a high-confidence investigation report and
 * persist it to codebase_knowledge. Only saves when confidence >= 0.8 and
 * rootCauseType is known.
 */
export async function extractAndSaveBugPattern(
  db: Database.Database,
  report: InvestigationReport,
): Promise<void> {
  if (report.confidence < 0.8) return; // don't save uncertain patterns
  if (report.rootCauseType === 'unknown') return;

  const area = deriveAreaSlug(report.rootCause); // e.g. 'ui5-async-api'
  const content = formatPatternContent(report);

  db.prepare(`
    INSERT INTO codebase_knowledge (repo, area, type, title, content, source_file)
    VALUES (?, ?, 'pattern', ?, ?, ?)
    ON CONFLICT(repo, area, type, title) DO UPDATE SET content = excluded.content, indexed_at = datetime('now')
  `).run(defaultRepoName(), area, `Pattern: ${report.rootCause.slice(0, 60)}`, content, `investigation/${report.issueKey}`);
}

function deriveAreaSlug(rootCause: string): string {
  return rootCause
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function formatPatternContent(report: InvestigationReport): string {
  return [
    `## Root Cause Pattern`,
    report.rootCause,
    ``,
    `## Type`,
    report.rootCauseType,
    ``,
    `## Fix Owner`,
    report.fixOwner,
    ``,
    `## Evidence`,
    report.evidence.map(e => `- ${e.type}: ${e.description}`).join('\n'),
    ``,
    `## Source`,
    `Derived from ${report.issueKey} investigation (confidence: ${report.confidence})`,
  ].join('\n');
}
