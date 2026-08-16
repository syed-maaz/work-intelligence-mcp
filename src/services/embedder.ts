/**
 * EP-37: Semantic search via Ollama (nomic-embed-text default; swappable
 * via EMBEDDER_MODEL env var per ADR-050 R2-B.2 2026-07-27).
 * Gated on Ollama being reachable — all functions degrade gracefully when unavailable.
 *
 * No API key needed. Install: brew install ollama && ollama pull nomic-embed-text
 * Default base URL: http://localhost:11434 (override with OLLAMA_BASE_URL env var)
 *
 * ADR-050 R2-B.2 (2026-07-27): EMBEDDING_MODEL is now env-configurable. Set
 * EMBEDDER_MODEL=bge-large or EMBEDDER_MODEL=snowflake-arctic-embed to swap
 * to a 1024-dim embedder. When the dim changes, existing embedded rows are
 * unusable — must re-embed prompt_memory / doc_embeddings / message_embeddings
 * or delete + let the boot chain re-populate. `model` column on every
 * embedding table records which embedder produced each row.
 */

import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Registry of supported embedders and their output dimensions. Add a row here
 * when adopting a new model. Query the row via EMBEDDING_MODEL / EMBEDDING_DIM.
 */
const EMBEDDER_DIMS: Record<string, number> = {
  'nomic-embed-text': 768,
  'bge-large': 1024,
  'snowflake-arctic-embed': 1024,
};

const EMBEDDING_MODEL = process.env.EMBEDDER_MODEL ?? 'nomic-embed-text';
const EMBEDDING_DIM = EMBEDDER_DIMS[EMBEDDING_MODEL] ?? 768;

// Warn if the operator picked a model we don't know the dim for.
if (!(EMBEDDING_MODEL in EMBEDDER_DIMS)) {
  process.stderr.write(
    `[embedder] warning: EMBEDDER_MODEL='${EMBEDDING_MODEL}' not in registry; defaulting dim=${EMBEDDING_DIM}. Add to EMBEDDER_DIMS in src/services/embedder.ts if it works.\n`,
  );
}

// ── Type ───────────────────────────────────────────────────────────────────

export interface EmbeddingRow {
  message_id: number;
  embedding: Buffer; // 768 × float32 = 3072 bytes
  embedded_at: string;
}

// ── Low-level Ollama call ──────────────────────────────────────────────────

function ollamaBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
}

/**
 * WI_EMBED_STUB=1 (STEP 12, OSS release): zero-connector demo mode. When no
 * Ollama is reachable, `embed` emits a deterministic hash-derived vector at
 * EMBEDDING_DIM instead of failing, so recall (semantic search, prompt-memory
 * ranking) runs with no local model and no cloud key. Precedence: real Ollama
 * on :11434 if present → WI_EMBED_STUB=1 hash vectors → clear message + skip.
 */
let stubWarned = false;

function stubEmbedding(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  const seed = createHash('sha256').update(text).digest();
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const b = seed[i % seed.length];
    vec[i] = ((b / 127.5) - 1) / 10;
  }
  return vec;
}

async function embed(text: string): Promise<Float32Array | null> {
  try {
    const resp = await fetch(`${ollamaBaseUrl()}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text.slice(0, 8000) }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { embedding: number[] };
    if (!json.embedding?.length) return null;
    return new Float32Array(json.embedding);
  } catch {
    // Ollama unreachable — fall through to the stub / skip paths below.
  }
  if (process.env.WI_EMBED_STUB === '1') {
    return stubEmbedding(text);
  }
  if (!stubWarned) {
    stubWarned = true;
    process.stderr.write(
      `[embedder] Ollama unavailable and WI_EMBED_STUB!=1 — skipping embeddings. ` +
        `Install Ollama (brew install ollama && ollama pull ${EMBEDDING_MODEL}) or set WI_EMBED_STUB=1 for the demo.\n`,
    );
  }
  return null;
}

export { embed };

/** Ping Ollama and confirm the configured embedder model is available. */
export async function checkOllamaAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${ollamaBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return false;
    const json = (await resp.json()) as { models: Array<{ name: string }> };
    return json.models.some((m) => m.name.startsWith(EMBEDDING_MODEL));
  } catch {
    return false;
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // ADR-050 R2-B.2 (2026-07-27): guard against dim mismatch. If EMBEDDER_MODEL
  // is swapped mid-lifecycle, stored embeddings from a prior model have a
  // different length than the current query vector, and the loop below would
  // walk off the end reading whatever memory is adjacent. Return 0 (treat as
  // "unrelated") when dims differ — callers should filter by `model` column
  // first (see rankPromptMemory) but this is the last-line defense.
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function bufferToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer);
}

// ── Public API ─────────────────────────────────────────────────────────────

export class EmbeddingService {
  private _enabled: boolean | null = null; // null = not yet checked

  constructor(private readonly db: Database.Database) {}

  get isEnabled(): boolean {
    // Synchronous read of cached state — call checkEnabled() first at startup
    return this._enabled === true;
  }

  /** Async check — call once at startup, result cached for the session. */
  async checkEnabled(): Promise<boolean> {
    if (this._enabled !== null) return this._enabled;
    this._enabled = await checkOllamaAvailable();
    return this._enabled;
  }

  /**
   * Embed a batch of messages (by id). Skips already-embedded messages.
   * No-ops silently when Ollama unavailable.
   */
  async indexMessages(messageIds: number[]): Promise<{ indexed: number; skipped: number }> {
    if (!(await this.checkEnabled())) return { indexed: 0, skipped: messageIds.length };

    const existing = new Set(
      (this.db.prepare('SELECT message_id FROM message_embeddings WHERE message_id IN (' +
        messageIds.map(() => '?').join(',') + ')').all(...messageIds) as Array<{ message_id: number }>)
        .map(r => r.message_id)
    );

    const upsert = this.db.prepare(`
      INSERT INTO message_embeddings (message_id, embedding, embedded_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(message_id) DO UPDATE SET embedding = excluded.embedding, embedded_at = excluded.embedded_at
    `);

    let indexed = 0;
    for (const id of messageIds) {
      if (existing.has(id)) continue;
      const msg = this.db.prepare('SELECT content, subject FROM messages WHERE id = ?').get(id) as
        | { content: string; subject: string | null }
        | undefined;
      if (!msg) continue;
      const text = [msg.subject, msg.content].filter(Boolean).join(' ');
      const vec = await embed(text);
      if (!vec) continue;
      upsert.run(id, float32ToBuffer(vec));
      indexed++;
    }
    return { indexed, skipped: messageIds.length - indexed };
  }

  /**
   * Hybrid search: FTS (keyword) + semantic similarity, merged by RRF.
   * Falls back to FTS-only when Ollama not available.
   *
   * @param query   Natural-language query
   * @param limit   Max results (default 15)
   * @param topicId Optional topic filter
   */
  async hybridSearch(
    query: string,
    limit = 15,
    topicId?: number
  ): Promise<Array<{ message_id: number; score: number; source: string }>> {
    const topicFilter = topicId ? 'AND m.topic_id = ?' : '';
    const topicArgs = topicId ? [topicId] : [];

    // FTS candidates
    const ftsTerms = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3)
      .join(' OR ');

    type MsgRow = { id: number; source: string };
    let ftsHits: MsgRow[] = [];
    if (ftsTerms) {
      try {
        ftsHits = this.db.prepare(`
          SELECT m.id, m.source
          FROM messages_fts
          JOIN messages m ON messages_fts.rowid = m.id
          WHERE messages_fts MATCH ? ${topicFilter}
          ORDER BY bm25(messages_fts)
          LIMIT ?
        `).all(ftsTerms, ...topicArgs, limit * 2) as MsgRow[];
      } catch { /* FTS unavailable */ }
    }

    // RRF scores from FTS rank
    const scores = new Map<number, number>();
    ftsHits.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (60 + i + 1));
    });

    // Semantic reranking when Ollama available
    if (this.isEnabled && ftsHits.length > 0) {
      const queryVec = await embed(query);
      if (queryVec) {
        const candidateIds = ftsHits.map(r => r.id);
        const embeds = this.db.prepare(
          'SELECT message_id, embedding FROM message_embeddings WHERE message_id IN (' +
            candidateIds.map(() => '?').join(',') + ')'
        ).all(...candidateIds) as Array<{ message_id: number; embedding: Buffer }>;

        for (const row of embeds) {
          const vec = bufferToFloat32(row.embedding);
          const sim = cosineSimilarity(queryVec, vec);
          // RRF-merge: semantic rank via similarity
          const semRank = 1 - sim; // lower = more relevant
          scores.set(row.message_id, (scores.get(row.message_id) ?? 0) + 1 / (60 + semRank * 100));
        }
      }
    }

    const sourceMap = new Map(ftsHits.map(r => [r.id, r.source]));

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([message_id, score]) => ({ message_id, score, source: sourceMap.get(message_id) ?? 'unknown' }));
  }
}

/** Singleton factory. */
export function createEmbeddingService(db: Database.Database): EmbeddingService {
  return new EmbeddingService(db);
}

export { EMBEDDING_DIM };

/**
 * Pure semantic search — embed the query and brute-force cosine similarity over
 * every row in `message_embeddings`. NO FTS prefilter. This is the whole point:
 * the FTS-gated `hybridSearch` returns [] for paraphrase / synonym / OOV queries,
 * which is exactly the failure mode this lane is meant to rescue.
 *
 * Contract:
 *   - returns [] on Ollama unreachable, table empty, or any internal error
 *   - never throws
 *   - 500ms internal timeout (matches the lane's outer race in web-server.js)
 *
 * Brute-force is fine well below ~50k vectors; we have ~1208 today.
 */
export async function semanticSearch(
  query: string,
  db: Database.Database,
  limit = 25,
): Promise<Array<{ message_id: number; score: number }>> {
  try {
    const result = await Promise.race<Array<{ message_id: number; score: number }> | 'timeout'>([
      (async () => {
        const queryVec = await embed(query);
        if (!queryVec) return [];

        const rows = db
          .prepare('SELECT message_id, embedding FROM message_embeddings')
          .all() as Array<{ message_id: number; embedding: Buffer }>;

        if (rows.length === 0) return [];

        const scored: Array<{ message_id: number; score: number }> = [];
        for (const row of rows) {
          try {
            const vec = bufferToFloat32(row.embedding);
            const sim = cosineSimilarity(queryVec, vec);
            scored.push({ message_id: row.message_id, score: sim });
          } catch {
            // skip corrupt row
          }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit);
      })(),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 500)),
    ]);

    if (result === 'timeout') return [];
    return result;
  } catch {
    return [];
  }
}

// ── Prompt-memory: learned prompt→skill recognition (v98) ────────────────────

/**
 * Backfill / incrementally embed past Cypher dispatch goals into prompt_memory.
 *
 * Reads cypher_sessions rows that have a goal + chosen_skill + outcome and are
 * not yet in prompt_memory, embeds each goal, and upserts. Ollama-gated: a no-op
 * (indexed: 0) when Ollama is unreachable — the recognition path in
 * getCatalogHint then falls back to description word-overlap.
 *
 * Idempotent by session_id: only rows missing from prompt_memory are embedded,
 * so repeated calls after new sessions close cost only the new goals.
 * @returns counts for the boot/close log line.
 */
export async function embedPromptMemory(
  db: Database.Database,
): Promise<{ indexed: number; skipped: number }> {
  if (!(await checkOllamaAvailable())) return { indexed: 0, skipped: 0 };

  const rows = db
    .prepare(
      `SELECT s.session_id, s.goal, s.chosen_skill, s.outcome
       FROM cypher_sessions s
       LEFT JOIN prompt_memory pm ON pm.session_id = s.session_id
       WHERE pm.session_id IS NULL
         AND s.goal IS NOT NULL AND s.goal != ''
         AND s.chosen_skill IS NOT NULL AND s.chosen_skill != ''
         AND s.outcome IS NOT NULL`,
    )
    .all() as Array<{ session_id: string; goal: string; chosen_skill: string; outcome: string }>;

  const upsert = db.prepare(
    `INSERT INTO prompt_memory (session_id, goal, chosen_skill, outcome, embedding, model, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       goal=excluded.goal, chosen_skill=excluded.chosen_skill, outcome=excluded.outcome,
       embedding=excluded.embedding, model=excluded.model, embedded_at=excluded.embedded_at`,
  );

  let indexed = 0;
  let skipped = 0;
  for (const row of rows) {
    const vec = await embed(row.goal);
    if (!vec) {
      // Transient Ollama failure mid-batch — skip this row, continue.
      skipped++;
      continue;
    }
    upsert.run(
      row.session_id,
      row.goal,
      row.chosen_skill,
      row.outcome,
      float32ToBuffer(vec),
      EMBEDDING_MODEL,
    );
    indexed++;
  }
  return { indexed, skipped };
}

// ── doc_embeddings (ADR-042 Gap 2 — recognition corpus) ─────────────────────

/** The three doc corpora Stage-1 recognizes against, relative to repo root. */
const DOC_CORPORA: Array<{ dir: string; kind: 'adr' | 'architecture' | 'epic' }> = [
  { dir: 'docs/docs/adr', kind: 'adr' },
  { dir: 'docs/docs/architecture', kind: 'architecture' },
  { dir: 'docs/docs/epics', kind: 'epic' },
];

/** First markdown `# heading` in the text, else the filename (no ext). */
function docTitle(text: string, path: string): string {
  const m = text.match(/^#\s+(.+)$/m);
  if (m && m[1]) return m[1].trim().slice(0, 200);
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/, '');
}

/**
 * Embed the ADR / architecture / epic markdown corpus into `doc_embeddings`
 * (ADR-042 "Gap 2"). Mirrors embedPromptMemory: Ollama-gated no-op when down,
 * incremental (only files whose sha256 changed are re-embedded), tolerant of
 * per-file failure, returns counts for the boot log line. A read/embed failure
 * on one file bumps `skipped` and continues.
 *
 * Change detection: each file's content_hash (sha256 of the raw text) is
 * compared against the stored row; unchanged → skipped (0 Ollama calls), so
 * repeated boots are cheap. Never throws.
 *
 * `repoRoot` is the absolute path to the repo (the dir containing docs/).
 * File reads are async (await readFile) and the loop yields per file, so the
 * backfill is loop-yielding network+IO — safe to run fire-and-forget at boot
 * without a worker (see CLAUDE.md "Bridge MUST never be blocked").
 */
export async function embedDocs(
  db: Database.Database,
  repoRoot: string,
): Promise<{ indexed: number; skipped: number; unchanged: number }> {
  if (!(await checkOllamaAvailable())) return { indexed: 0, skipped: 0, unchanged: 0 };

  const getHash = db.prepare(
    `SELECT content_hash FROM doc_embeddings WHERE path = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO doc_embeddings (path, title, doc_kind, content_hash, embedding, model, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       title=excluded.title, doc_kind=excluded.doc_kind, content_hash=excluded.content_hash,
       embedding=excluded.embedding, model=excluded.model, embedded_at=excluded.embedded_at`,
  );

  let indexed = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const { dir, kind } of DOC_CORPORA) {
    let files: string[];
    try {
      files = readdirSync(join(repoRoot, dir)).filter((f) => f.endsWith('.md'));
    } catch {
      // Corpus dir missing (e.g. a checkout without docs/) — skip the whole dir.
      continue;
    }
    for (const file of files) {
      const relPath = `${dir}/${file}`;
      try {
        const text = await readFile(join(repoRoot, dir, file), 'utf8');
        const hash = createHash('sha256').update(text).digest('hex');
        const existing = getHash.get(relPath) as { content_hash: string } | undefined;
        if (existing && existing.content_hash === hash) {
          unchanged++;
          continue;
        }
        // Embed title + body (title carries the strongest recognition signal).
        // Cap the input at ~4000 chars: nomic-embed-text has a ~2048-TOKEN
        // context, and dense markdown (code blocks, tables) can exceed it well
        // before embed()'s generic 8000-CHAR slice — Ollama then 500s
        // ("input length exceeds the context length") and the file silently
        // skips. 4000 chars stays safely under the token ceiling for every
        // file in the corpus, and ADR recognition signal is front-loaded
        // (title + Context/Decision opening), so the head is what matters.
        const title = docTitle(text, relPath);
        const vec = await embed(`${title}\n\n${text}`.slice(0, 4000));
        if (!vec) {
          skipped++;
          continue;
        }
        upsert.run(relPath, title, kind, hash, float32ToBuffer(vec), EMBEDDING_MODEL);
        indexed++;
      } catch {
        skipped++;
      }
    }
  }
  return { indexed, skipped, unchanged };
}

/**
 * Cosine-search the doc_embeddings corpus for a query. Mirrors semanticSearch:
 * brute-force cosine over the whole (small, ~144-row) table, wrapped in a
 * 500ms race, returns [] on Ollama-down / empty / any error (never throws).
 * Recognition-only — returns doc identity (path/title/kind) + score, NOT
 * content (deep retrieval is Stage-3's job, per ADR-042).
 */
export async function searchDocs(
  query: string,
  db: Database.Database,
  limit = 8,
): Promise<Array<{ path: string; title: string; doc_kind: string; score: number }>> {
  const run = async (): Promise<Array<{ path: string; title: string; doc_kind: string; score: number }>> => {
    const queryVec = await embed(query);
    if (!queryVec) return [];
    let rows: Array<{ path: string; title: string; doc_kind: string; embedding: Buffer }>;
    try {
      rows = db
        .prepare(`SELECT path, title, doc_kind, embedding FROM doc_embeddings`)
        .all() as Array<{ path: string; title: string; doc_kind: string; embedding: Buffer }>;
    } catch {
      // Table missing (fresh DB pre-migration).
      return [];
    }
    if (rows.length === 0) return [];
    const scored = rows.map((r) => ({
      path: r.path,
      title: r.title,
      doc_kind: r.doc_kind,
      score: cosineSimilarity(queryVec, bufferToFloat32(r.embedding)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  };
  try {
    return await Promise.race([
      run(),
      new Promise<Array<{ path: string; title: string; doc_kind: string; score: number }>>((resolve) =>
        setTimeout(() => resolve([]), 500),
      ),
    ]);
  } catch {
    return [];
  }
}

/**
 * Rank skills for a goal by learned prompt-memory: cosine-match the goal against
 * embedded past goals, weight each match by outcome (success 1.0 / mixed 0.5 /
 * failed 0.0) and by whether it clears the similarity gate, and aggregate per
 * skill. Returns null when Ollama is down or the memory is empty, so the caller
 * (getCatalogHint) can fall back to description word-overlap.
 *
 * @param simGate minimum cosine to count a match (locality gate — self-corrects
 *   the dev-goal skew: a new goal only matches semantically-near past goals).
 *   Default 0.72: only STRONG learned matches win; weaker goals fall through to
 *   description word-overlap in getCatalogHint, so cold/thin-history skills
 *   (e.g. wi-pr-review) are still surfaced by their description rather than
 *   pre-empted by a loosely-related past goal (tuned from live data 2026-07-15).
 * @returns per-skill aggregated evidence, sorted desc by score, or null.
 */
export async function rankPromptMemory(
  goal: string,
  db: Database.Database,
  simGate = 0.72,
): Promise<Array<{ skill: string; score: number; sim: number; matches: number }> | null> {
  const queryVec = await embed(goal);
  if (!queryVec) return null;

  let rows: Array<{ chosen_skill: string; outcome: string; embedding: Buffer }>;
  try {
    rows = db
      .prepare(
        // Recognition-recall fix (ADR-042, 2026-07-25): scope to Cypher-
        // DISPATCHABLE skills only (wi-* prefix — skill-autoregister.ts:84).
        // prompt_memory contains 11 non-wi chosen_skill values (playground,
        // build-mcp-app, senior-backend, …) from past dispatches that routed to
        // a non-routable skill; surfacing them here poisons the top-1 (para-01
        // top1 was 'playground'). The loop can only dispatch wi-*, so recall
        // must be measured against wi-* only.
        //
        // ADR-050 R2-B.2 (2026-07-27): also filter by `model` to match the
        // current EMBEDDING_MODEL. When the embedder is swapped (e.g.
        // EMBEDDER_MODEL=bge-large → 1024-dim), stored 768-dim nomic vectors
        // are unusable — cosineSimilarity would walk off the end and read
        // garbage. Filtering here means old rows are inert until re-embedded,
        // which is the correct behavior during an A/B swap diagnostic.
        `SELECT chosen_skill, outcome, embedding FROM prompt_memory
         WHERE chosen_skill LIKE 'wi-%' AND model = ?`,
      )
      .all(EMBEDDING_MODEL) as Array<{ chosen_skill: string; outcome: string; embedding: Buffer }>;
  } catch {
    return null; // table missing (fresh DB before migration/backfill)
  }
  if (rows.length === 0) return null;

  // Phase-0 M1 F1.2 fix: filter prompt_memory rows by DISPATCHABLE_SKILLS
  // when the env flag is set. Without this, the sweep's cleaned-variant
  // top-1 predictions include skills that are NOT in SKILL_ROUTES (e.g.
  // `playground`, `build-mcp-app`, `adversarial-reviewer`) because
  // prompt_memory retains historically-chosen skill names regardless of
  // whether they still exist as dispatchable routes. Same env-gate pattern
  // as the getCatalogHint and getCatalogHintWordOverlap filters in
  // tool-catalog.ts. See ADR-050 GATE-RESOLVED §11 F1.2, WORKSTREAM-A doc.
  if (process.env.STAGE1_DISPATCHABLE_ONLY === '1') {
    const { DISPATCHABLE_SKILLS } = await import('./cypher/skill-dispatch.js');
    rows = rows.filter((r) => DISPATCHABLE_SKILLS.has(r.chosen_skill));
    if (rows.length === 0) return null; // filter emptied the set
  }

  // Outcome → weight. EXPLICIT for every cypher_sessions.outcome CHECK value
  // (success|mixed|failed|halted|abandoned|rejected_non_interactive), so no
  // value falls through to a silent default (audit BLOCKER-2: `abandoned` is
  // ~15% of the corpus and was being weighted as mixed via `?? 0.5`).
  // Only completed-successful work is positive evidence a skill FIT this goal
  // shape; mixed is half. `failed` is NEGATIVE evidence (audit HIGH-3,
  // 2026-07-25): a skill that was tried on a similar goal and failed is a
  // signal AGAINST re-picking it, not merely neutral. -0.25 (small; the
  // aggregate is floored at 0 below so a burned skill sinks toward the bottom
  // but never goes negative — negative scores would sort below cold skills
  // that have no evidence at all, which is wrong: a burned-once skill is still
  // more relevant than a totally-unrelated one). halted/abandoned/rejected
  // stay 0 (neutral — the work didn't ship, but not because the skill was
  // wrong; often the user interrupted or the session was non-interactive).
  const OUTCOME_WEIGHT: Record<string, number> = {
    success: 1.0,
    mixed: 0.5,
    failed: -0.25,
    halted: 0.0,
    abandoned: 0.0,
    rejected_non_interactive: 0.0,
  };
  // Aggregate per skill: keep the best (max) outcome-weighted match, raw sim,
  // and count of gate-clearing matches.
  const agg = new Map<string, { score: number; sim: number; matches: number }>();
  for (const row of rows) {
    let vec: Float32Array;
    try {
      vec = bufferToFloat32(row.embedding);
    } catch {
      continue; // skip corrupt row
    }
    const sim = cosineSimilarity(queryVec, vec);
    if (sim < simGate) continue;
    // Unknown outcome (a future CHECK value not yet mapped) → SKIP, don't guess
    // a weight. Prevents silent mis-weighting when the schema widens again.
    const w = OUTCOME_WEIGHT[row.outcome];
    if (w === undefined) continue;
    const contribution = sim * w;
    const cur = agg.get(row.chosen_skill);
    if (!cur) {
      agg.set(row.chosen_skill, { score: contribution, sim, matches: 1 });
    } else {
      cur.matches++;
      if (contribution > cur.score) cur.score = contribution;
      if (sim > cur.sim) cur.sim = sim;
    }
  }
  if (agg.size === 0) return null; // nothing cleared the gate

  // ── Anti-domination (audit HIGH-2 root fix, 2026-07-15) ──────────────
  // Corpus is 77% wi-investigate + wi-search. A skill with 432 rows in
  // prompt_memory has ~432 chances to produce a >simGate cosine match on
  // any reasoning-shaped goal, so max-of-matches always crowns it.
  //
  // Fix: down-weight by *observed match saturation* — if a skill matched
  // a huge fraction of its total corpus rows for this goal, that's evidence
  // of loose matching (corpus dominance), not specificity. Skills whose
  // matches are a smaller fraction of their corpus rows are more likely
  // to be genuine signal.
  //
  // Compute per-skill corpus size (total prompt_memory rows for that skill,
  // regardless of sim). Then specificity = matches / total_corpus_rows,
  // capped at 1.0. Final score = raw_score × (0.3 + 0.7 × log1p(matches) / log1p(20))
  // — logarithmic saturation so a lucky-1 match doesn't dominate a solid-5,
  // but a 400-match wi-investigate doesn't outweigh a 5-match wi-blast-radius
  // linearly either.
  const skillCorpusSizes = new Map<string, number>();
  try {
    const sizeRows = db
      .prepare("SELECT chosen_skill, COUNT(*) as n FROM prompt_memory WHERE chosen_skill LIKE 'wi-%' GROUP BY chosen_skill")
      .all() as Array<{ chosen_skill: string; n: number }>;
    for (const r of sizeRows) skillCorpusSizes.set(r.chosen_skill, r.n);
  } catch {
    // If the count query fails, fall through with empty map (no penalty).
  }

  const LOG20 = Math.log1p(20);
  const adjusted = new Map<string, { score: number; sim: number; matches: number }>();
  for (const [skill, v] of agg.entries()) {
    const corpusSize = skillCorpusSizes.get(skill) ?? v.matches;
    // Specificity — how much of this skill's corpus matched this goal?
    // Low = broad-loose match (e.g. 432-row wi-investigate producing 40
    // matches on any goal). High = focused match.
    const specificity = Math.min(1.0, v.matches / Math.max(1, corpusSize));
    // Log-saturation on matches — 1 match ≈ 0.19, 5 ≈ 0.60, 20 ≈ 1.0.
    // Rewards a few consistent matches without letting outlier corpora win.
    const matchWeight = 0.3 + 0.7 * (Math.log1p(v.matches) / LOG20);
    // Combine: raw score × log-saturation × specificity floor.
    // Specificity floor at 0.3 so cold skills (1 row in corpus, 1 match →
    // specificity=1.0) don't over-benefit from perfect ratio when the raw
    // sim was marginal.
    const specificityFactor = 0.3 + 0.7 * specificity;
    // Floor at 0 (audit HIGH-3): a skill whose only matches were `failed`
    // has a negative v.score; the negative weight pushes it below cold skills
    // in ordering, but the surfaced score must not be negative (a negative
    // number in the hint reads as nonsense to the 1b LLM). max(0, …) clamps
    // burned skills to 0 — present but bottom-ranked, not fabricated-negative.
    const adjustedScore = Math.max(0, v.score * matchWeight * specificityFactor);
    adjusted.set(skill, { score: adjustedScore, sim: v.sim, matches: v.matches });
  }

  return [...adjusted.entries()]
    .map(([skill, v]) => ({ skill, score: v.score, sim: v.sim, matches: v.matches }))
    .sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
}

