/**
 * v49 — Widen `code_graph.ref_type` CHECK enum to include the three new
 * non-TS regex extractor outputs:
 *
 *   - 'docker_base_image'  (Dockerfile  ^FROM ...)
 *   - 'helm_chart_dep'     (Helm Chart.yaml dependencies: - name: ...)
 *   - 'shell_env_ref'      (.sh files   $ENV_VAR / ${ENV_VAR})
 *
 * SQLite does not support `ALTER TABLE ... DROP CONSTRAINT`, so we follow the
 * canonical pattern: create a new table with the widened CHECK, copy rows,
 * drop the old, rename. All indexes are recreated against the new table.
 *
 * The set of pre-existing ref_type values is preserved verbatim — this is a
 * pure additive widening, no row data changes.
 *
 * Idempotent: if the new table already exists (interrupted run) the
 * transaction will fail and roll back; on retry the original `code_graph`
 * is still intact and the migration restarts from scratch.
 */
import type Database from 'better-sqlite3';

export default function migrateV49(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE code_graph_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        file_path TEXT NOT NULL,
        symbol TEXT,
        ref_repo TEXT NOT NULL,
        ref_file TEXT NOT NULL,
        ref_symbol TEXT,
        ref_type TEXT NOT NULL CHECK(ref_type IN (
          'import', 'call', 'type', 'api_call', 'env_var',
          'test_covers', 'config_ref',
          'docker_base_image', 'helm_chart_dep', 'shell_env_ref'
        )),
        line_number INTEGER,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)
      );

      INSERT INTO code_graph_new
        (id, repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type, line_number, indexed_at)
      SELECT
        id, repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type, line_number, indexed_at
      FROM code_graph;

      DROP TABLE code_graph;
      ALTER TABLE code_graph_new RENAME TO code_graph;

      CREATE INDEX IF NOT EXISTS idx_code_graph_source ON code_graph(repo, file_path);
      CREATE INDEX IF NOT EXISTS idx_code_graph_ref    ON code_graph(ref_repo, ref_file);
      CREATE INDEX IF NOT EXISTS idx_code_graph_type   ON code_graph(ref_type);
    `);
  })();
}
