/**
 * Phase 79-03 + 79-5b + 79-06 — unconditional pre-chat recall helper.
 *
 * Called once per /api/chat message BEFORE the verb-router branch. Runs
 * recallMemory() (with SQLite lanes restored per Phase 79-01) plus a
 * topic_notebooks lookup, and returns a formatted string ready to inject
 * into the system prompt as a "## Prior context" block.
 *
 * Phase 79-5b: embeds the query via Ollama (nomic-embed-text) once, passes
 * the resulting queryBlob to recallMemory so the three cosine lanes
 * (message_cosine, prompt_memory_cosine, doc_cosine) participate.
 * Non-fatal on embedder-offline — LIKE lanes still fire when queryBlob is null.
 *
 * Phase 79-06 extension: when the query is coding-shaped, also prepends
 * code-memory hits from codebase_knowledge + code_graph.
 *
 * Non-throwing: any error is logged and the function returns '' so the chat
 * path stays available even if palace is offline or DB is contended.
 */
import type Database from 'better-sqlite3';
import type { PalaceClient } from '../../intelligence/palace-client.js';
import { recallMemory, type RecallResult } from './recall.js';
import { embed } from '../embedder.js';
import { float32ArrayToBlob } from './cosine-udf.js';
import { queryCodeMemory, type CodeMemoryHit } from './code-memory.js';

const NOTEBOOK_HIT_CAP = 3;
const RECALL_HIT_CAP = 5;
const CODE_MEMORY_CAP = 5;

export interface PreflightContextArgs {
  db: Database.Database;
  message: string;
  palace?: PalaceClient | null;
}

export async function buildPreflightContext(
  args: PreflightContextArgs,
): Promise<string> {
  const { db, message, palace = null } = args;
  const trimmed = message.trim();
  if (!trimmed) return '';

  const parts: string[] = [];

  // Phase 79-5b: embed query once; reused across all cosine lanes.
  let queryBlob: Buffer | null = null;
  try {
    const queryVec = await embed(trimmed);
    if (queryVec) {
      queryBlob = float32ArrayToBlob(queryVec);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preflight] embed failed (falling back to LIKE-only): ${msg.slice(0, 120)}`);
  }

  // 1. Notebook lookup (LIKE, cheap, deterministic).
  try {
    const keywords = trimmed
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 4)
      .slice(0, 3);
    if (keywords.length > 0) {
      const clauses = keywords
        .map(() => `(lower(topic_name) LIKE ? OR lower(content) LIKE ?)`)
        .join(' OR ');
      const params = keywords.flatMap((k) => [`%${k}%`, `%${k}%`]);
      const notebooks = db
        .prepare(
          `SELECT topic_name, substr(content, 1, 400) AS excerpt, last_updated
             FROM topic_notebooks
            WHERE ${clauses}
            ORDER BY last_updated DESC
            LIMIT ${NOTEBOOK_HIT_CAP}`,
        )
        .all(...params) as Array<{ topic_name: string; excerpt: string; last_updated: string }>;
      for (const nb of notebooks) {
        parts.push(`- [notebook] ${nb.topic_name} (updated ${nb.last_updated}): ${nb.excerpt}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preflight] notebook lookup failed: ${msg.slice(0, 120)}`);
  }

  // 2. Full recallMemory fan-out (SQLite lanes + cosine lanes when blob available).
  try {
    const recalled: RecallResult[] = await recallMemory({
      db,
      pattern: trimmed,
      palace,
      limit: RECALL_HIT_CAP,
      // Explicitly pass wings=[] and sqliteLanes=true so preflight always
      // sees the full fan-out regardless of the chat mode.
      wings: [],
      sqliteLanes: true,
      queryBlob,
    });
    for (const r of recalled) {
      const snippet = r.snippet.replace(/\s+/g, ' ').trim().slice(0, 200);
      parts.push(`- [${r.source}] ${r.id}: ${snippet} (score ${r.score.toFixed(2)})`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preflight] recallMemory failed: ${msg.slice(0, 120)}`);
  }

  // 3. Phase 79-06: code-memory recall for coding-shaped queries.
  //    Gated by isCodingQuery() inside queryCodeMemory — non-coding returns [] fast.
  try {
    const codeHits: CodeMemoryHit[] = queryCodeMemory(db, trimmed, CODE_MEMORY_CAP);
    for (const h of codeHits) {
      parts.push(`- [${h.source}] ${h.title}: ${h.content.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preflight] code-memory recall failed: ${msg.slice(0, 120)}`);
  }

  if (parts.length === 0) return '';
  return [
    '## Prior context (auto-recalled)',
    'The following memory was recalled based on your message. Cite it if relevant, do not repeat it verbatim.',
    ...parts,
  ].join('\n');
}
