/**
 * src/services/cypher/heartbeat.ts — G1 Heartbeat infrastructure.
 *
 * Replaces the static "healthy" status lie with heartbeat-table derived
 * freshness. Writes a row per worker/phase on every loop entry;
 * status/health endpoints read from the same table so uptime is
 * observable.
 *
 * Table: heartbeats (worker TEXT PK, last_seen INTEGER epoch-ms,
 *   phase TEXT, metadata TEXT)
 */

import type Database from 'better-sqlite3';

const HEARTBEAT_STALE_THRESHOLD_MS = 120_000; // 2 minutes

export interface HeartbeatAgentStatus {
  name: string;
  lastSeen: number;
  ageSec: number;
  phase: string;
}

export interface HeartbeatStatus {
  healthy: boolean;
  agents: HeartbeatAgentStatus[];
}

/**
 * Migration-safe CREATE TABLE IF NOT EXISTS.
 */
export function createHeartbeatTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      worker TEXT PRIMARY KEY,
      last_seen INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT '',
      metadata TEXT
    )
  `);
}

/**
 * Upsert a single heartbeat row. At most one row per worker name.
 */
export function writeHeartbeat(
  db: Database.Database,
  worker: string,
  phase: string,
  metadata?: string,
): void {
  createHeartbeatTable(db);
  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO heartbeats (worker, last_seen, phase, metadata)
    VALUES (?, ?, ?, ?)
  `).run(worker, now, phase, metadata ?? null);
}

/**
 * Read freshness status. healthy=true only if every known worker's
 * last_seen is within HEARTBEAT_STALE_THRESHOLD_MS of now.
 *
 * If the heartbeats table is empty (no workers registered yet),
 * returns healthy=false with empty agents array.
 */
export function readHeartbeatStatus(db: Database.Database): HeartbeatStatus {
  createHeartbeatTable(db);
  const now = Date.now();
  const rows = db.prepare(`
    SELECT worker, last_seen, phase, metadata
    FROM heartbeats
    ORDER BY worker
  `).all() as Array<{
    worker: string; last_seen: number; phase: string;
    metadata: string | null;
  }>;

  if (rows.length === 0) {
    return { healthy: false, agents: [] };
  }

  const agents: HeartbeatAgentStatus[] = rows.map(r => ({
    name: r.worker,
    lastSeen: r.last_seen,
    ageSec: Math.round((now - r.last_seen) / 1000),
    phase: r.phase,
  }));

  const allFresh = agents.every(a => (now - a.lastSeen) < HEARTBEAT_STALE_THRESHOLD_MS);

  return { healthy: allFresh, agents };
}
