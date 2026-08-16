/**
 * ChangeWatcher — CDC polling service (Phase 63)
 *
 * Polls `changes_log` every 100ms using a cursor (id > lastSeenId).
 * Emits typed Node.js events consumed by agents in web-server.js.
 *
 * Four-Stage Pipeline: this is the Process stage.
 * Architectural constraint: no AI calls here — Process stage only.
 */
import EventEmitter from 'node:events';
import type Database from 'better-sqlite3';

export type ChangeEvent =
  | { type: 'new-message';     rowId: number; operation: 'INSERT' }
  | { type: 'jira-update';     rowId: number; operation: 'INSERT' | 'UPDATE' }
  | { type: 'calendar-change'; rowId: number; operation: 'INSERT' };

interface ChangeRow {
  id: number;
  table_name: string;
  row_id: number;
  operation: string;
}

interface MaxIdRow {
  max_id: number;
}

export class ChangeWatcher extends EventEmitter {
  private lastSeenId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _cleanupTick = 0;
  private readonly CLEANUP_EVERY = 600; // every 60s at 100ms interval

  /**
   * Set paused = true in tests that write to DB without wanting to trigger agents.
   * Cursor still advances (so backlog is skipped when unpaused), but events are suppressed.
   */
  paused = false;

  constructor(
    private readonly db: Database.Database,
    private readonly intervalMs = 100
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    // Seed cursor to current MAX(id) so we only process NEW changes after startup.
    // Prevents processing historical backlog on restart.
    const row = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM changes_log')
      .get() as MaxIdRow;
    this.lastSeenId = row.max_id;
    this.timer = setInterval(() => this._poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private _poll(): void {
    // Cleanup: delete rows older than 1 hour to prevent unbounded table growth.
    // Throttled to once every CLEANUP_EVERY ticks (600 × 100ms = 60s) to avoid
    // unnecessary write locks on an otherwise-idle table.
    this._cleanupTick = (this._cleanupTick + 1) % this.CLEANUP_EVERY;
    if (this._cleanupTick === 0) {
      this.db
        .prepare(`DELETE FROM changes_log WHERE created_at < datetime('now', '-1 hour')`)
        .run();
    }

    const rows = this.db
      .prepare(
        `SELECT id, table_name, row_id, operation
         FROM changes_log
         WHERE id > ?
         ORDER BY id ASC
         LIMIT 500`
      )
      .all(this.lastSeenId) as ChangeRow[];

    if (rows.length === 0) return;

    // Advance cursor regardless of paused state — avoids reprocessing on unpause
    this.lastSeenId = rows[rows.length - 1].id;

    if (this.paused) return;

    for (const row of rows) {
      if (row.table_name === 'messages' && row.operation === 'INSERT') {
        this.emit('new-message', {
          type: 'new-message',
          rowId: row.row_id,
          operation: 'INSERT',
        } satisfies ChangeEvent);
      } else if (row.table_name === 'jira_issues') {
        this.emit('jira-update', {
          type: 'jira-update',
          rowId: row.row_id,
          operation: row.operation as 'INSERT' | 'UPDATE',
        } satisfies ChangeEvent);
      } else if (row.table_name === 'calendar_events' && row.operation === 'INSERT') {
        this.emit('calendar-change', {
          type: 'calendar-change',
          rowId: row.row_id,
          operation: 'INSERT',
        } satisfies ChangeEvent);
      }
    }
  }
}
