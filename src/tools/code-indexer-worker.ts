/**
 * Code-graph indexer worker — runs CPU-heavy ts-morph parsing OFF the
 * bridge's main event loop.
 *
 * Spawned by `src/tools/code-indexer.ts` via `new Worker(...)`. The worker:
 *
 *   1. Reads its mission from `workerData`:
 *        { databasePath, repo, mode: 'full' | 'incremental' | 'changed',
 *          sinceMs?, changedFiles?, progressEveryN? }
 *   2. Opens its own `better-sqlite3` Database handle (cross-thread handle
 *      sharing is forbidden by the binding). WAL is process-wide on the DB
 *      file, so the new handle inherits it.
 *   3. Walks repo files, parses each with ts-morph, calls `extractEdgesImpl`
 *      (imported from `code-indexer.ts` — same edge-extraction logic as
 *      every other caller).
 *   4. `project.removeSourceFile(sf)` after each file — the OOM fix from
 *      commit d9ca432 (see `project_bridge_oom_and_event_loop_rule.md`)
 *      is preserved.
 *   5. Inserts edges into `code_graph` in a single transaction at the end
 *      (full mode) or per-file (incremental mode — matches existing
 *      indexChangedSince semantics).
 *   6. Emits `{ type: 'progress', filesDone, filesTotal, ratio }` every
 *      `progressEveryN` files so the optional SSE consumer can stream a
 *      progress bar. Default N=25 — that's roughly every 1–2 seconds on
 *      the repo's ts-morph throughput.
 *   7. Emits `{ type: 'result', ... }` and exits 0 on success, or
 *      `{ type: 'error', message, stack }` on failure.
 *
 * Architectural rule satisfied: bridge main thread never parses ts-morph.
 * See `CLAUDE.md § Bridge MUST never be blocked by any call`.
 *
 * History:
 *   - 2026-06-24: created during the worker-thread migration
 *     (CLAUDE.md "Known offender" → resolved).
 */

import { parentPort, workerData } from 'worker_threads';
import { existsSync, statSync } from 'fs';
import { relative } from 'path';
import { Project } from 'ts-morph';
import Database from 'better-sqlite3';

import {
  findTsFiles,
  findFilesByExt,
  findFilesByName,
  findTsConfig,
} from './code-indexer-helpers.js';
import {
  extractEdgesImpl,
  extractNonTsEdgesFullSweep,
  extractNonTsEdgesForFile,
  type CodeEdge,
} from './code-indexer.js';

// ──────────────────────────────────────────────────────────────────────────────
// Worker contract — keep in sync with code-indexer.ts' WorkerMission /
// WorkerResult types.
// ──────────────────────────────────────────────────────────────────────────────

export type WorkerMode = 'full' | 'incremental';

export interface WorkerMission {
  databasePath: string;
  repo: { name: string; localPath: string };
  mode: WorkerMode;
  /** Required for mode='incremental'. Only files with mtimeMs > sinceMs are scanned. */
  sinceMs?: number;
  /** Optional: emit a progress event every N files. Default 25. */
  progressEveryN?: number;
}

export interface WorkerProgress {
  type: 'progress';
  filesDone: number;
  filesTotal: number;
  ratio: number;
}

export interface WorkerFullResult {
  type: 'result';
  mode: 'full';
  repo: string;
  filesIndexed: number;
  edgesAdded: number;
  durationMs: number;
}

export interface WorkerIncrementalResult {
  type: 'result';
  mode: 'incremental';
  repo: string;
  filesProcessed: number;
  edgesAdded: number;
  edgesRemoved: number;
  durationMs: number;
  sinceMs: number;
}

export interface WorkerError {
  type: 'error';
  message: string;
  stack?: string;
}

export type WorkerMessage = WorkerProgress | WorkerFullResult | WorkerIncrementalResult | WorkerError;

// ──────────────────────────────────────────────────────────────────────────────
// Worker entry
// ──────────────────────────────────────────────────────────────────────────────

function post(msg: WorkerMessage): void {
  parentPort?.postMessage(msg);
}

function reportProgress(filesDone: number, filesTotal: number, everyN: number): void {
  // Skip the "0/N" event (caller knows we started). Emit on every Nth file
  // and on the final file regardless of modulo so consumers see a clean
  // 100% before the result event.
  if (filesDone === 0) return;
  if (filesDone === filesTotal || filesDone % everyN === 0) {
    post({
      type: 'progress',
      filesDone,
      filesTotal,
      ratio: filesTotal === 0 ? 1 : filesDone / filesTotal,
    });
  }
}

async function runFull(db: Database.Database, mission: WorkerMission): Promise<void> {
  const start = Date.now();
  const { repo } = mission;
  const everyN = mission.progressEveryN ?? 25;

  if (!existsSync(repo.localPath)) {
    throw new Error(`Repo path not found: ${repo.localPath}`);
  }

  // Mirror CodeIndexer.indexRepo: wipe everything for this repo first so
  // deletions are reflected. The main thread does NOT also DELETE before
  // spawning — that would race the worker's own DELETE. The worker is the
  // sole writer for this repo for the duration of the run (lock held in
  // main thread).
  db.prepare('DELETE FROM code_graph WHERE repo = ?').run(repo.name);

  const tsFiles = findTsFiles(repo.localPath);
  const tsConfigPath = findTsConfig(repo.localPath);
  const project = new Project({
    tsConfigFilePath: tsConfigPath ?? undefined,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: tsConfigPath ? undefined : { allowJs: true },
  });

  const edges: CodeEdge[] = [];
  // OOM-fix invariant preserved from commit d9ca432 — keep peak AST
  // footprint bounded to one file at a time. See
  // `project_bridge_oom_and_event_loop_rule.md` for the full story.
  let filesDone = 0;
  for (const absPath of tsFiles) {
    const relPath = relative(repo.localPath, absPath);
    const sf = project.addSourceFileAtPath(absPath);
    edges.push(...extractEdgesImpl(sf, repo.name, repo.localPath, relPath));
    project.removeSourceFile(sf);
    filesDone++;
    reportProgress(filesDone, tsFiles.length, everyN);
  }

  // Non-TS pass — Dockerfile / Helm / shell / (operations YAML config_ref).
  edges.push(...extractNonTsEdgesFullSweep(repo));

  const insertEdge = db.prepare(`
    INSERT OR REPLACE INTO code_graph
      (repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type, line_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction((list: CodeEdge[]) => {
    for (const e of list) {
      insertEdge.run(e.repo, e.file_path, e.symbol, e.ref_repo, e.ref_file, e.ref_symbol, e.ref_type, e.line_number);
    }
  });
  insertAll(edges);

  // ADR-027 v2 item #2 — full sweep MUST advance sync_state.
  db.prepare(`
    INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(topic_id, source) DO UPDATE SET
        last_synced_at     = excluded.last_synced_at,
        last_message_count = excluded.last_message_count
  `).run('0', `code-graph-${repo.name}`, new Date().toISOString(), edges.length);

  post({
    type: 'result',
    mode: 'full',
    repo: repo.name,
    filesIndexed: tsFiles.length,
    edgesAdded: edges.length,
    durationMs: Date.now() - start,
  });
}

async function runIncremental(db: Database.Database, mission: WorkerMission): Promise<void> {
  const start = Date.now();
  const { repo } = mission;
  const sinceMs = mission.sinceMs ?? 0;
  const everyN = mission.progressEveryN ?? 25;

  if (!existsSync(repo.localPath)) {
    throw new Error(`Repo path not found: ${repo.localPath}`);
  }

  const all = findTsFiles(repo.localPath);
  const changed: string[] = [];
  for (const abs of all) {
    try {
      const st = statSync(abs);
      if (st.mtimeMs > sinceMs) changed.push(abs);
    } catch {
      // skip unreadable
    }
  }

  const nonTsCandidates = [
    ...findFilesByName(repo.localPath, [/^Dockerfile(\..+)?$/, /^Chart\.ya?ml$/]),
    ...findFilesByExt(repo.localPath, ['.sh']),
  ];
  const nonTsChanged: string[] = [];
  for (const abs of nonTsCandidates) {
    try {
      const st = statSync(abs);
      if (st.mtimeMs > sinceMs) nonTsChanged.push(abs);
    } catch {
      // skip unreadable
    }
  }

  const insertEdge = db.prepare(`
    INSERT OR REPLACE INTO code_graph
      (repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type, line_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM code_graph WHERE repo = ? AND file_path = ?');
  const deleteStmt = db.prepare('DELETE FROM code_graph WHERE repo = ? AND file_path = ?');

  let edgesRemoved = 0;
  let edgesAdded = 0;
  const totalFiles = changed.length + nonTsChanged.length;
  let filesDone = 0;

  if (changed.length > 0) {
    const tsConfigPath = findTsConfig(repo.localPath);
    const project = new Project({
      tsConfigFilePath: tsConfigPath ?? undefined,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: tsConfigPath ? undefined : { allowJs: true },
    });

    const tx = db.transaction(() => {
      for (const abs of changed) {
        const relPath = relative(repo.localPath, abs);
        const before = (countStmt.get(repo.name, relPath) as { n: number } | undefined)?.n ?? 0;
        deleteStmt.run(repo.name, relPath);
        edgesRemoved += before;

        const sf = project.addSourceFileAtPath(abs);
        const fileEdges = extractEdgesImpl(sf, repo.name, repo.localPath, relPath);
        for (const e of fileEdges) {
          insertEdge.run(e.repo, e.file_path, e.symbol, e.ref_repo, e.ref_file, e.ref_symbol, e.ref_type, e.line_number);
        }
        edgesAdded += fileEdges.length;
        // Same OOM-fix invariant as the full sweep.
        project.removeSourceFile(sf);
        filesDone++;
      }
    });
    tx();
    // Progress is reported after the transaction commits — postMessage
    // inside a sync transaction would still work, but emitting a single
    // 100%-ish event keeps the wire quiet during incremental work that's
    // usually a handful of files anyway.
    reportProgress(filesDone, totalFiles, everyN);
  }

  if (nonTsChanged.length > 0) {
    const tx = db.transaction(() => {
      for (const abs of nonTsChanged) {
        const relPath = relative(repo.localPath, abs);
        const before = (countStmt.get(repo.name, relPath) as { n: number } | undefined)?.n ?? 0;
        deleteStmt.run(repo.name, relPath);
        edgesRemoved += before;

        const fileEdges = extractNonTsEdgesForFile(repo, abs, relPath);
        for (const e of fileEdges) {
          insertEdge.run(e.repo, e.file_path, e.symbol, e.ref_repo, e.ref_file, e.ref_symbol, e.ref_type, e.line_number);
        }
        edgesAdded += fileEdges.length;
        filesDone++;
      }
    });
    tx();
    reportProgress(filesDone, totalFiles, everyN);
  }

  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(topic_id, source) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      last_message_count = sync_state.last_message_count + excluded.last_message_count
  `).run('0', `code-graph-${repo.name}`, nowIso, edgesAdded - edgesRemoved);

  post({
    type: 'result',
    mode: 'incremental',
    repo: repo.name,
    filesProcessed: changed.length + nonTsChanged.length,
    edgesAdded,
    edgesRemoved,
    durationMs: Date.now() - start,
    sinceMs,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('code-indexer-worker.ts must be loaded via new Worker(); parentPort is null');
  }
  const mission = workerData as WorkerMission;
  if (!mission || !mission.repo || !mission.databasePath) {
    throw new Error('code-indexer-worker: workerData missing required fields');
  }

  const db = new Database(mission.databasePath);
  db.pragma('busy_timeout = 5000');
  // WAL is a process-wide pragma on the file; we don't need to set it here.
  // We DO need a write-friendly synchronous setting — leave defaults.
  try {
    if (mission.mode === 'full') {
      await runFull(db, mission);
    } else if (mission.mode === 'incremental') {
      await runIncremental(db, mission);
    } else {
      throw new Error(`Unknown worker mode: ${mission.mode}`);
    }
  } finally {
    try { db.close(); } catch { /* swallow */ }
  }
}

main().catch((err) => {
  post({
    type: 'error',
    message: (err && err.message) || String(err),
    stack: err && err.stack ? err.stack : undefined,
  });
  // Exit with a non-zero code so the spawner's 'exit' handler can also
  // distinguish error from clean completion (defense in depth — the
  // 'error' message is the primary signal).
  process.exit(1);
});
