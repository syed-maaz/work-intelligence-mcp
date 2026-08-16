import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { globSync } from 'node:fs';
import type Database from 'better-sqlite3';
import {
  recordPatternFeedback,
  getStaleKnowledgeIds,
} from '../db/queries/investigation.js';
import { defaultRepoName } from './repo-names.js';

// ---------------------------------------------------------------------------
// Knowledge Indexer — Phase 55 full implementation + Phase 56 feedback & TTL refresh
// ---------------------------------------------------------------------------
// Scans repo docs on server startup. Incremental: skips files unchanged
// since last indexed_at. Also provides extractAndSaveBugPattern (Phase 56 wiring)
// and refreshStaleEntries (Phase 56 TTL-based decay).

/**
 * Minimal shape for a bug pattern extracted by the investigation engine.
 * Phase 55 Wave 5 will define the canonical interface.
 */
export interface BugPattern {
  repo: string;
  area: string;
  title: string;
  rootCauseType: string;
  fixOwner?: string;
  description: string;
  relatedFiles: string[];
}

export class KnowledgeIndexer {
  private initialized = false;

  constructor(private db: Database.Database, private repoPath: string) {}

  async indexAll(): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0, skipped = 0;

    // ADRs
    const adrs = globSync(`${this.repoPath}/docs/docs/adr/*.md`);
    for (const file of adrs) {
      if (await this.indexDoc(file, defaultRepoName(), 'adr', 'architecture')) indexed++;
      else skipped++;
    }

    // CLAUDE.md and .claude/rules
    const rules: string[] = [];
    try { statSync(`${this.repoPath}/CLAUDE.md`); rules.push(`${this.repoPath}/CLAUDE.md`); } catch { /* not present */ }
    const ruleFiles = globSync(`${this.repoPath}/.claude/rules/*.md`);
    rules.push(...ruleFiles);
    for (const file of rules) {
      if (await this.indexDoc(file, defaultRepoName(), 'rules', 'architecture')) indexed++;
      else skipped++;
    }

    // README
    try {
      statSync(`${this.repoPath}/README.md`);
      if (await this.indexDoc(`${this.repoPath}/README.md`, defaultRepoName(), 'overview', 'architecture')) indexed++;
      else skipped++;
    } catch { /* README not present */ }

    // Seed ownership from CODEOWNERS if present
    await this.indexOwnershipFromCODEOWNERS();

    this.initialized = true;
    return { indexed, skipped };
  }

  private async indexDoc(
    filePath: string, repo: string, area: string, type: string
  ): Promise<boolean> {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      return false; // file doesn't exist
    }

    const existing = this.db.prepare(
      `SELECT indexed_at FROM codebase_knowledge WHERE repo=? AND area=? AND source_file=?`
    ).get(repo, area, filePath) as { indexed_at: string } | undefined;

    // SQLite datetime('now') has second precision; add 1s buffer so files indexed
    // in the same second as their mtime are still considered up-to-date.
    if (existing) {
      const indexedMs = new Date(existing.indexed_at + 'Z').getTime() + 1000;
      if (indexedMs > stat.mtime.getTime()) return false; // up to date
    }

    const content = readFileSync(filePath, 'utf8').slice(0, 4000); // cap at 4k chars
    const title = basename(filePath, '.md');

    this.db.prepare(`
      INSERT INTO codebase_knowledge (repo, area, type, title, content, source_file, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(repo, area, type, title) DO UPDATE SET
        content = excluded.content, indexed_at = excluded.indexed_at
    `).run(repo, area, type, title, content, filePath);

    return true;
  }

  private async indexOwnershipFromCODEOWNERS(): Promise<void> {
    const codeownersPath = `${this.repoPath}/CODEOWNERS`;
    let raw: string;
    try {
      raw = readFileSync(codeownersPath, 'utf8');
    } catch {
      return; // no CODEOWNERS file — skip
    }

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const [pathGlob, ...owners] = parts;
      const team = owners[0] ?? null;

      this.db.prepare(`
        INSERT INTO subsystem_owners (repo, path_glob, team, owner)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(repo, path_glob) DO UPDATE SET
          team  = excluded.team,
          owner = excluded.owner
      `).run(defaultRepoName(), pathGlob, team, owners[1] ?? null);
    }
  }

  /**
   * Extract a bug pattern from a concluded investigation and save it
   * to `codebase_knowledge`. After saving, cross-reference prior
   * investigation sessions to record pattern feedback for matching
   * root cause types.
   *
   * TODO(Phase 55 Wave 5): Wire this call into the investigation
   * pipeline after conclusion extraction.
   */
  extractAndSaveBugPattern(db: Database.Database, pattern: BugPattern): void {
    // Pack description + related files into the content column as JSON
    const contentPayload = JSON.stringify({
      description: pattern.description,
      rootCauseType: pattern.rootCauseType,
      fixOwner: pattern.fixOwner,
      relatedFiles: pattern.relatedFiles,
    });

    // Upsert the pattern into codebase_knowledge
    db.prepare(`
      INSERT INTO codebase_knowledge (repo, area, type, title, content, source_file, indexed_at)
      VALUES (?, ?, 'pattern', ?, ?, ?, datetime('now'))
      ON CONFLICT(repo, area, type, title) DO UPDATE SET
        content     = excluded.content,
        source_file = excluded.source_file,
        indexed_at  = datetime('now')
    `).run(
      pattern.repo,
      pattern.area,
      pattern.title,
      contentPayload,
      pattern.relatedFiles[0] ?? null,
    );

    // --- Phase 56 pattern feedback wiring ---
    // Find the just-saved pattern row
    const patternRow = db.prepare(
      `SELECT id FROM codebase_knowledge WHERE repo = ? AND area = ? AND type = 'pattern' AND title = ? LIMIT 1`,
    ).get(pattern.repo, pattern.area, pattern.title) as { id: number } | undefined;

    if (patternRow) {
      // Find prior completed sessions that share the same root cause type and owner
      const relatedSessions = db.prepare(`
        SELECT id FROM investigation_sessions
        WHERE conclusion LIKE ? AND owner_team = ? AND status = 'done'
        LIMIT 10
      `).all(
        `%"rootCauseType":"${pattern.rootCauseType}"%`,
        pattern.fixOwner ?? '',
      ) as Array<{ id: number }>;

      for (const sess of relatedSessions) {
        recordPatternFeedback(db, patternRow.id, sess.id, {
          confirmed: true,
          contradicted: false,
        });
      }
    }
  }

  /**
   * Delete codebase_knowledge rows older than KNOWLEDGE_TTL_DAYS and
   * (optionally) re-index so they are rediscovered from fresh source data.
   *
   * Called as the last step of runFullSync in web-server.js.
   * Accepts an explicit db so the singleton can be used without a constructor db.
   */
  async refreshStaleEntries(db: Database.Database): Promise<number> {
    const staleIds = getStaleKnowledgeIds(db);
    if (staleIds.length === 0) return 0;

    const placeholders = staleIds.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM codebase_knowledge WHERE id IN (${placeholders})`,
    ).run(...staleIds);

    // If indexer has been initialized, trigger incremental re-index now
    // Temporarily bind the provided db so indexAll() can use it
    if (this.initialized) {
      const prevDb = this.db;
      this.db = db;
      await this.indexAll();
      this.db = prevDb;
    }

    return staleIds.length;
  }
}

// Singleton for use by web-server.js refreshStaleEntries calls (db injected at call-site).
// For indexAll(), create a new KnowledgeIndexer(db, repoPath) with a real db instance.
export const knowledgeIndexer = new KnowledgeIndexer(
  null as unknown as Database.Database,
  process.env['CODEBASE_PATH'] ?? './repos',
);
