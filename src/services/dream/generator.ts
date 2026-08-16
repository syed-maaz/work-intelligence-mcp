/**
 * dream/generator.ts — in-process GENERATE pass for the /dream feature.
 *
 * Runs inside the bridge (no headless `claude -p`): extracts the last N hours of
 * human-typed messages, asks the model (digest bucket) to propose durable memory
 * changes, and writes memory/.dream/dream-report.{json,md}. Writes ONLY the
 * report — never a memory file (apply is human-gated, see dream-apply.mjs).
 *
 * Anthropic call site: uses bucketCallParams(db, 'digest') per the model-config
 * rule — the /setup/models admin UI controls model + effort for this call.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { bucketCallParams } from '../model-config.js';

const HOME = process.env.HOME || '';
const MEM_DIR =
  process.env.WI_DREAM_MEM_DIR ||
  join(HOME, '.wi', 'memory');
const REPORT_JSON = join(MEM_DIR, '.dream', 'dream-report.json');
const REPORT_MD = join(MEM_DIR, '.dream', 'dream-report.md');
const REPO = process.cwd();
const EXTRACT = join(REPO, 'scripts', 'dream-extract.sh');

export interface DreamItem {
  id: number;
  type: 'add' | 'update' | 'prune';
  target: string;
  room?: string;
  frontmatter?: unknown;
  body?: string;
  index_line?: string;
  evidence: string;
  rationale: string;
  status: 'pending' | 'applied' | 'rejected';
}
export interface DreamReport {
  generated_at: string;
  window_hours: number;
  items: DreamItem[];
}

/** INGEST — human-typed messages only (promptSource typed|queued), last N hours. */
function extractCorpus(hours: number): string {
  try {
    return execFileSync('bash', [EXTRACT, String(hours)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return '';
  }
}

/** COMPARE inputs — the index + the list of existing memory slugs (to avoid dups). */
function memoryContext(): { index: string; priorRejected: DreamItem[] } {
  const index = existsSync(join(MEM_DIR, 'MEMORY.md')) ? readFileSync(join(MEM_DIR, 'MEMORY.md'), 'utf8') : '';
  let priorRejected: DreamItem[] = [];
  if (existsSync(REPORT_JSON)) {
    try {
      const prior = JSON.parse(readFileSync(REPORT_JSON, 'utf8')) as DreamReport;
      priorRejected = (prior.items || []).filter((i) => i.status === 'rejected');
    } catch { /* ignore */ }
  }
  return { index, priorRejected };
}

const SYSTEM = `You are the DREAM generator for the Work Intelligence project — a nightly, in-process memory-consolidation pass.
Propose durable memory changes from what the USER TYPED. Apply nothing.

HARD RULES:
1. USER-TYPED FACTS ONLY. Every proposal's "evidence" is a VERBATIM quote from the corpus (which is already filtered to human-typed messages). Never invent, never use tool output.
2. DURABLE ONLY. Lasting preferences / corrections / decisions / project facts worth recalling in FUTURE sessions. Skip one-off task chatter and anything already in the memory index. Customer-repo (Jira/PR) task instructions are NOT WI memory. 0 items is a valid, honest result.
3. NEVER re-propose an item in the "previously rejected" list.

Classify each: add | update | prune. Match the memory Shape-A schema:
  filename: <type>_<snake_slug>.md ; type ∈ feedback|project|bug|decision|reference|fact|spike
  frontmatter: { name, description(<=200 chars), metadata:{node_type:"memory", type, originSessionId} }
  body: bold-label sections (**Rule:**/**Why:**/**How to apply:** or **Decision (date)**), [[wikilinks]]
  index_line: "- [<emoji?> <Title> (YYYY-MM-DD)](file.md) — <terse hook>. Detail in file."

Output ONLY a JSON object via the emit_dream_report tool.`;

const TOOL = {
  name: 'emit_dream_report',
  description: 'Emit the dream report as structured proposals.',
  input_schema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            type: { type: 'string', enum: ['add', 'update', 'prune'] },
            target: { type: 'string' },
            room: { type: 'string' },
            frontmatter: { type: 'object' },
            body: { type: 'string' },
            index_line: { type: 'string' },
            evidence: { type: 'string' },
            rationale: { type: 'string' },
          },
          required: ['id', 'type', 'target', 'evidence', 'rationale'],
        },
      },
    },
    required: ['items'],
  },
};

function renderMd(report: DreamReport): string {
  const lines = [`# Dream Report — ${report.generated_at} (${report.window_hours}h window)`, '', `Proposals: ${report.items.length}`, ''];
  for (const it of report.items) {
    lines.push(`## ${it.id}. [${it.type.toUpperCase()}] ${it.target}`);
    lines.push(`**Evidence (you typed):** "${it.evidence}"`);
    lines.push(`**Rationale:** ${it.rationale}`);
    if (it.body) lines.push('', '```', it.body, '```');
    lines.push('', `**Status:** ${it.status}`, '');
  }
  return lines.join('\n');
}

/**
 * Run the generate pass. Returns the report (also written to disk).
 * @param db bridge sqlite handle (for bucketCallParams).
 * @param opts.hours lookback window (default 24).
 * @param opts.apiKey Anthropic key (ctx.anthropicApiKey).
 */
export async function generateDreamReport(
  db: Database.Database,
  opts: { hours?: number; apiKey?: string } = {},
): Promise<DreamReport> {
  const hours = opts.hours ?? 24;
  const nowIso = new Date().toISOString();
  const corpus = extractCorpus(hours);
  const { index, priorRejected } = memoryContext();

  // Empty corpus → honest empty report, no LLM spend.
  if (!corpus.trim()) {
    const empty: DreamReport = { generated_at: nowIso, window_hours: hours, items: [] };
    writeReport(empty);
    return empty;
  }

  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL ? { baseURL, defaultHeaders: { Authorization: `Bearer ${apiKey}` } } : {}),
  });
  const params = bucketCallParams(db, 'digest');
  const userMsg = [
    `## Human-typed corpus (last ${hours}h)`,
    corpus.slice(0, 200_000),
    '',
    '## Existing memory index (MEMORY.md)',
    index.slice(0, 60_000),
    '',
    '## Previously rejected (do NOT re-propose)',
    JSON.stringify(priorRejected.map((i) => ({ target: i.target, evidence: i.evidence })), null, 2),
  ].join('\n');

  const resp = await client.beta.promptCaching.messages.create({
    ...params,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'emit_dream_report' },
    messages: [{ role: 'user', content: userMsg }],
  });

  const block = resp.content.find((b) => b.type === 'tool_use');
  const items: DreamItem[] = (block && 'input' in block ? (block.input as { items?: DreamItem[] }).items : []) || [];
  items.forEach((it, i) => { it.id = i + 1; it.status = 'pending'; if (!it.room) it.room = 'topics'; });

  const report: DreamReport = { generated_at: nowIso, window_hours: hours, items };
  writeReport(report);
  return report;
}

function writeReport(report: DreamReport): void {
  mkdirSync(dirname(REPORT_JSON), { recursive: true });
  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  writeFileSync(REPORT_MD, renderMd(report));
}
