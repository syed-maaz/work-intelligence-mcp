/**
 * Phase 79-07 — one-shot mem-claude → WI ingest.
 *
 * Reads all rows from ~/.claude-mem/claude-mem.db::observations and inserts
 * into WI's external_observations, deduped by content_hash. Idempotent — safe
 * to re-run if interrupted.
 *
 * Usage:
 *   PATH=$HOME/.nvm/versions/node/v24.7.0/bin:$PATH npx tsx scripts/ingest-mem-claude.ts
 *   # or with a custom path:
 *   MEM_CLAUDE_DB=/path/to/backup.db npx tsx scripts/ingest-mem-claude.ts
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const MC_PATH = process.env.MEM_CLAUDE_DB ?? path.join(os.homedir(), '.claude-mem/claude-mem.db');
const WI_PATH = process.env.WI_DB ?? path.join(os.homedir(), '.work-intelligence-mcp/data.db');

const mc = new Database(MC_PATH, { readonly: true });
const wi = new Database(WI_PATH);

const rows = mc
  .prepare(
    `SELECT id, memory_session_id, project, text, type AS observation_type,
            title, subtitle, facts, narrative, concepts,
            files_read, files_modified, prompt_number, content_hash,
            generated_by_model, created_at, created_at_epoch
       FROM observations
      ORDER BY id`,
  )
  .all() as Array<{
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  observation_type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  content_hash: string | null;
  generated_by_model: string | null;
  created_at: string;
  created_at_epoch: number;
}>;

console.log(`[ingest] found ${rows.length} rows in mem-claude`);

const insert = wi.prepare(`
  INSERT OR IGNORE INTO external_observations (
    source, source_row_id, memory_session_id, project, observation_type,
    title, subtitle, text, facts_json, narrative, concepts_json,
    files_read_json, files_modified_json, prompt_number, content_hash,
    generated_by_model, observation_created_at, observation_created_at_epoch
  ) VALUES (
    'mem-claude', @source_row_id, @memory_session_id, @project, @observation_type,
    @title, @subtitle, @text, @facts, @narrative, @concepts,
    @files_read, @files_modified, @prompt_number, @content_hash,
    @generated_by_model, @created_at, @created_at_epoch
  )
`);

let inserted = 0;
let skipped = 0;

const insertMany = wi.transaction(
  (batch: typeof rows) => {
    for (const r of batch) {
      const info = insert.run({
        source_row_id: r.id,
        memory_session_id: r.memory_session_id ?? null,
        project: r.project ?? 'unknown',
        observation_type: r.observation_type ?? 'note',
        title: r.title ?? null,
        subtitle: r.subtitle ?? null,
        text: r.text ?? null,
        facts: r.facts ?? null,
        narrative: r.narrative ?? null,
        concepts: r.concepts ?? null,
        files_read: r.files_read ?? null,
        files_modified: r.files_modified ?? null,
        prompt_number: r.prompt_number ?? null,
        content_hash: r.content_hash ?? null,
        generated_by_model: r.generated_by_model ?? null,
        created_at: r.created_at,
        created_at_epoch: r.created_at_epoch,
      });
      if (info.changes > 0) inserted++;
      else skipped++;
    }
  },
);

for (let i = 0; i < rows.length; i += 1000) {
  insertMany(rows.slice(i, i + 1000));
  if (i % 5000 === 0 && i > 0) console.log(`[ingest] progress ${i}/${rows.length}...`);
}

console.log(`[ingest] done. inserted=${inserted} skipped=${skipped}`);

const topProjects = wi
  .prepare(
    `SELECT project, COUNT(*) AS n FROM external_observations
      WHERE source='mem-claude'
      GROUP BY project ORDER BY n DESC LIMIT 10`,
  )
  .all() as Array<{ project: string; n: number }>;
console.log('[ingest] top projects:', topProjects.map((r) => `${r.project}(${r.n})`).join(', '));

mc.close();
wi.close();
