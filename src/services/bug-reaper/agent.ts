/**
 * BugReaperAgent — G6-REAPER propose-only worker.
 *
 * Tick-based worker that polls the bugs table for unresolved bugs, dispatches
 * investigation via skill-dispatch (`wi-investigate`), and writes proposals to
 * a NEW `bug_proposals` table. Propose-only — never auto-applies, handles, or
 * mutates existing bug state.
 *
 * Gate: BUG_REAPER_ENABLED=1 (default-off).
 * Start: 30s delay after boot, then ticks every BUG_REAPER_INTERVAL_MS (default 30min).
 *
 * Refs: docs/planning/MULTIAGENT-EXECUTION-2026-08-06.md § G6
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface BugReaperOptions {
  db: Database.Database;
  bridgeBaseUrl?: string;
  /** Not used internally — interval is set by the web-server.js boot block via BUG_REAPER_INTERVAL_MS. */
  intervalMs?: number;
}

interface BugCandidate {
  id: number;
  fingerprint: string;
  status: string;
  first_seen_at: string;
  error_name: string | null;
  message: string | null;
  top_frame: string | null;
  occurrence_count: number | null;
  severity: string | null;
}

export interface TickResult {
  investigated: number;
  skipped: string | null;
  proposalId?: string;
  error?: string;
}

export class BugReaperAgent {
  private db: Database.Database;
  private inFlight = false;

  constructor(opts: BugReaperOptions) {
    this.db = opts.db;
    void opts.bridgeBaseUrl;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bug_proposals (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        reaper_run_at   INTEGER NOT NULL,
        finding         TEXT NOT NULL,
        confidence      REAL NOT NULL,
        proposal        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'proposed'
      )
    `);
  }

  async tick(): Promise<TickResult> {
    if (process.env.BUG_REAPER_ENABLED !== '1') {
      return { investigated: 0, skipped: 'disabled' };
    }
    if (this.inFlight) {
      return { investigated: 0, skipped: 'in_flight' };
    }
    this.inFlight = true;
    try {
      return await this.tickImpl();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[BugReaper] tick error: ${errMsg}\n`);
      return { investigated: 0, skipped: null, error: errMsg };
    } finally {
      this.inFlight = false;
    }
  }

  private async tickImpl(): Promise<TickResult> {
    const candidate = this.pickCandidate();
    if (!candidate) return { investigated: 0, skipped: 'no_candidate' };

    return await this.investigate(candidate);
  }

  private pickCandidate(): BugCandidate | null {
    const row = this.db
      .prepare(
        `SELECT b.id, b.fingerprint, b.status, b.first_seen_at,
                b.error_name, b.message, b.top_frame,
                b.occurrence_count, b.severity
           FROM bugs b
          WHERE b.status NOT IN ('resolved', 'auto-resolved', 'wont-fix', 'unable-to-resolve')
            AND b.id NOT IN (SELECT CAST(task_id AS INTEGER) FROM bug_proposals WHERE task_id IS NOT NULL)
          ORDER BY
            CASE b.status WHEN 'new' THEN 0 WHEN 'investigating' THEN 1 WHEN 'proposed' THEN 2 ELSE 3 END,
            b.first_seen_at ASC
          LIMIT 1`,
      )
      .get() as BugCandidate | undefined;

    return row ?? null;
  }

  private async investigate(candidate: BugCandidate): Promise<TickResult> {
    const now = Date.now();
    const proposalId = randomUUID();

    // Internal bugs (fingerprint-based) have no Jira issueKey — the
    // /api/jira/investigate route requires one. Analyze the bug row directly:
    // finding from error_name/message/top_frame, confidence from severity +
    // occurrence count, proposal from the top frame location.
    const finding = [
      candidate.error_name ? `error: ${candidate.error_name}` : null,
      candidate.message ? `message: ${candidate.message}` : null,
      candidate.top_frame ? `top_frame: ${candidate.top_frame}` : null,
      candidate.occurrence_count !== null ? `occurrences: ${candidate.occurrence_count}` : null,
      candidate.severity ? `severity: ${candidate.severity}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    const confidence = this.computeConfidence(candidate);
    const location = this.extractLocation(candidate.top_frame);
    const proposal =
      `Investigate ${candidate.error_name ?? 'unknown error'} in ` +
      `${location} — ${candidate.occurrence_count ?? 0} occurrence(s), severity ${candidate.severity ?? 'unknown'}. ` +
      'Propose-only: no fix applied.';

    this.db
      .prepare(
        `INSERT INTO bug_proposals (id, task_id, reaper_run_at, finding, confidence, proposal, status)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed')`,
      )
      .run(proposalId, String(candidate.id), now, finding, confidence, proposal);

    process.stderr.write(
      `[BugReaper] bug=#${candidate.id} fp=${candidate.fingerprint} ` +
        `conf=${confidence.toFixed(2)} → proposal ${proposalId}\n`,
    );

    return { investigated: 1, skipped: null, proposalId };
  }

  /** Confidence heuristic: base 0.5, +0.2 for high/critical severity,
   *  +0.1 per magnitude of occurrence count, capped at 0.95. */
  private computeConfidence(candidate: BugCandidate): number {
    let conf = 0.5;
    const sev = (candidate.severity ?? '').toLowerCase();
    if (sev.includes('high') || sev.includes('critical') || sev.includes('fatal')) {
      conf += 0.2;
    } else if (sev.includes('medium') || sev.includes('moderate')) {
      conf += 0.1;
    }
    const occ = candidate.occurrence_count ?? 0;
    if (occ >= 100) conf += 0.2;
    else if (occ >= 10) conf += 0.15;
    else if (occ >= 2) conf += 0.05;
    return Math.min(0.95, Math.round(conf * 100) / 100);
  }

  /** Extract a readable location from a stack frame like
   *  "at fn (file:///path/src/foo.ts:42:3)". Falls back to the raw frame. */
  private extractLocation(topFrame: string | null): string {
    if (!topFrame) return 'unknown location';
    const fileMatch = topFrame.match(/\(([^)]+:\d+:\d+)\)/);
    if (fileMatch) return fileMatch[1].replace(/^file:\/\//, '');
    const bareMatch = topFrame.match(/(\S+:\d+:\d+)/);
    if (bareMatch) return bareMatch[1];
    return topFrame.slice(0, 160);
  }
}
