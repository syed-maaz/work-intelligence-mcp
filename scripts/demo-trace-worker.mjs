import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { publicPath } from './demo-sandbox.mjs';
import { demoTools } from './demo-tools.mjs';
import { writeProof } from './demo-proof.mjs';
import { guardedDemoClient } from './demo-client.mjs';
const { getDatabase } = await import('../src/db/connection.js');
const { runLoop } = await import('../src/services/cypher/loop.js');
const { recallMemory } = await import('../src/services/brain/recall.js');

const GOAL =
  process.env.DEMO_GOAL ??
  'What happened with the PROJ-101 widget rollout on acme/widgets? Summarize the work, the postmortem, and any open items.';
const DB_PATH = process.env.DATABASE_PATH;
const TRACE_PAGE = publicPath('docs/docs/walkthroughs/loop-trace.md');

const POSTURE = 'generic';
const TASK_CLASS = 'generic';
const MAX_ITERATIONS = 10;

/** Truncate a value for the trace (input / result payloads). */
function clip(v, n = 300) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Extract the recall-relevant fields from a tool input, if any. */
function recallAnnotation(input = {}) {
  const lanes = Array.isArray(input.lanes) ? input.lanes : null;
  const query = input.query ?? input.pattern ?? input.query_text ?? null;
  if (!lanes && !query) return null;
  return {
    lanes,
    query: typeof query === 'string' ? query.slice(0, 200) : query,
  };
}

/**
 * Read back the cypher_steps rows the loop wrote for this session.
 * Direct SELECT (not health.ts getSessionDetail) because the trace wants
 * reasoning_trace / phase / tokens_used, which the lens omits. Same
 * ordering contract (stage_index ASC) so the chain reconstructs in the
 * order the loop fired tools.
 */
function readSteps(db, sessionId) {
  return db
    .prepare(
      `SELECT stage, stage_index, status, payload, tokens_used, duration_ms,
              reasoning_trace, controller_model, phase, created_at
         FROM cypher_steps
        WHERE session_id = ?
        ORDER BY stage_index ASC, id ASC`,
    )
    .all(sessionId)
    .map((r) => {
      let payload = r.payload;
      try { payload = payload ? JSON.parse(payload) : null; } catch { /* keep raw */ }
      return { ...r, payload };
    });
}

/** Format one trace section per tool_use row. */
function renderTurn(step, eligible) {
  const tool = step.payload?.tool ?? '(unknown)';
  const input = step.payload?.input ?? {};
  const def = eligible.find((d) => d.name === tool);
  const why = def ? clip(typeof def.description === 'string' ? def.description : `skill-backed: ${def.description.skill}`, 240) : '(not in the posture catalog — unexpected)';
  const rec = recallAnnotation(input);
  const out = [];
  out.push(`### Turn ${step.stage_index} — tool \`${tool}\``);
  out.push('');
  out.push('- **Stage:** `' + (step.phase ?? 'execute') + '` (tool_use row)');
  out.push(`- **Tool picked:** \`${tool}\``);
  out.push(`  - **Why eligible:** ${why}`);
  out.push(`  - **Input:** \`\`\`json\n${clip(input, 400)}\n\`\`\``);
  if (rec) {
    out.push(`  - **Recall lanes hit:** ${rec.lanes?.length ? rec.lanes.join(', ') : 'query-only (no lane filter)'} — query \`${clip(rec.query ?? '', 160)}\``);
  } else {
    out.push('- **Recall lanes hit:** none (this call is not a recall-lane query)');
  }
  if (step.reasoning_trace) {
    out.push(`- **Model reasoning (iteration):** "${clip(String(step.reasoning_trace).trim(), 400)}"`);
  }
  out.push(`- **EXECUTE:** \`${step.status}\` in ${step.duration_ms ?? '?'}ms` + (step.status === 'failed' ? ` — see result below` : ''));
  out.push('');
  return out.join('\n');
}

function renderTrace(result, steps, sessionRow, outcomeRow, priors, eligible, startedAt) {
  const u = result.usage;
  const scopeSteps = steps.filter((s) => s.phase === 'scope');
  const toolSteps = steps.filter((s) => s.stage === 'tool_use');
  const out = [];
  out.push('---');
  out.push('sidebar_position: 1');
  out.push('title: Cypher loop trace — demo run');
  out.push('---');
  out.push('');
  out.push('# Cypher loop trace — demo run');
  out.push('');
  out.push('> **Auto-generated** by `npm run demo:trace` (`scripts/demo-loop-trace.mjs`).');
  out.push('> Reproducible: set `ANTHROPIC_API_KEY` and re-run — this page is overwritten from the loop\'s own `cypher_steps` audit rows, never hand-faked.');
  out.push('');
  out.push('## Run facts');
  out.push('');
  out.push(`- **Goal:** ${result.goal ?? GOAL}`);
  out.push(`- **Session:** \`${result.session_id}\` · posture=\`${POSTURE}\` · task_class=\`${TASK_CLASS}\` · user=\`demo\``);
  out.push(`- **Database:** \`isolated fictional demo database\``);
  out.push(`- **Generated:** ${startedAt} · engine=loop · max_iterations=${MAX_ITERATIONS}`);
  out.push(`- **Loop verdict:** \`${result.verdict}\` (cypher_sessions.outcome=\`${sessionRow?.outcome ?? '?'}\`)`);
  out.push(`- **Surface:** ${result.surface ? `"${clip(result.surface, 240)}"` : '(empty)'}`);
  out.push(`- **Tool calls:** ${result.tool_calls.length} · duration ${result.duration_ms}ms`);
  out.push(`- **Tokens:** input ${u.input_tokens} · output ${u.output_tokens} · cache-read ${u.cache_read_tokens} · cache-write ${u.cache_write_tokens}`);
  out.push(`- **Beta-prior snapshot at entry:** count=${result.prior_count}, success_rate=${result.prior_success_rate ?? 'null'} (cold start)`);
  out.push('');
  out.push('## SCOPE refine');
  out.push('');
  if (scopeSteps.length > 0) {
    out.push(`A SCOPE refine pass ran (${scopeSteps.length} phase='scope' step row(s) persisted).`);
    for (const s of scopeSteps) {
      out.push(`- \`${s.stage}\` status=\`${s.status}\` tokens=${s.tokens_used} payload=${clip(s.payload, 200)}`);
    }
  } else {
    out.push(`No SCOPE pass ran — single-pass execute (CYPHER_REFINEMENT_ENABLED not set; see ADR-039 AC-7). The loop went straight to the execute-phase tool loop.`);
  }
  out.push('');
  out.push('## Eligible tool surface (isolated local-only demo)');
  out.push('');
  out.push(`The catalog exposes ${eligible.length} tools to the model for this posture; the loop picked ${toolSteps.length} of them. "Why eligible" per pick is the catalog\'s own description.`);
  out.push('');
  for (const d of eligible) {
    out.push(`- \`${d.name}\` — ${clip(typeof d.description === 'string' ? d.description : `skill-backed: ${d.description.skill}`, 140)}`);
  }
  out.push('');
  out.push('## Turn-by-turn annotated trace');
  out.push('');
  for (const step of toolSteps) {
    out.push(renderTurn(step, eligible));
  }
  if (toolSteps.length === 0) {
    out.push('_No tool_use rows persisted (loop halted before any tool fired, or the session row was missing — see run stderr)._\n');
  }
  out.push('## Loop close');
  out.push('');
  out.push(`- **Verdict:** \`${result.verdict}\``);
  if (result.outcome_note) out.push(`- **Outcome note (model):** "${clip(result.outcome_note, 240)}"`);
  out.push(`- **Beta-prior update:** verdict signal written to \`cypher_outcomes\` — signal_kind=verdict, value=${outcomeRow?.value ?? '?'}, metadata.verdict=${outcomeRow?.metadata?.verdict ?? result.verdict}${outcomeRow?.failure_pattern ? `, failure_pattern=${outcomeRow.failure_pattern}` : ''}.`);
  out.push(`- **skill_priors:** ${priors.length} row(s) present (keyed by skill/task_class; the loop does not write skill_priors directly — learn.ts is the sole writer, so a demo run leaves priors untouched).`);
  out.push('');
  return out.join('\n');
}

export async function runDemoTrace({ anthropicClient } = {}) {
  if (!process.env.ANTHROPIC_API_KEY && !anthropicClient) {
    console.log(
      '[demo-loop-trace] requires ANTHROPIC_API_KEY (runLoop makes real paid Anthropic calls). ' +
        'Set the key and re-run to generate docs/docs/walkthroughs/loop-trace.md — the placeholder page ships as-is.',
    );
    return null;
  }

  const db = getDatabase({ path: DB_PATH });
  const sessionId = `cyp_demo_${randomUUID()}`;

  // runLoop requires the cypher_sessions row to exist first (loop.ts:324-327):
  // the FK on cypher_steps.session_id cascades from it, persistOutcome UPDATEs
  // it, and recordOutcomeSignal rejects unknown sessions.
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, task_class, user, posture, status)
     VALUES (?, ?, ?, 'demo', ?, 'pending')`,
  ).run(sessionId, GOAL, TASK_CLASS, POSTURE);

  const result = await runLoop({
    db,
    palace: null,
    anthropic_client: guardedDemoClient(demoTools(db,recallMemory),anthropicClient),
    tools: demoTools(db, recallMemory),
    goal: GOAL,
    user: 'demo',
    session_id: sessionId,
    posture: POSTURE,
    task_class: TASK_CLASS,
    confirm_mode: 'auto',
    is_interactive: false,
    halt_flag: { get halted() { return false; }, halt() {} },
    max_iterations: MAX_ITERATIONS,
  });

  const steps = readSteps(db, sessionId);
  const sessionRow = db.prepare(
    `SELECT session_id, goal, outcome, outcome_note, chosen_skill, scope_iters, total_tokens,
            duration_ms, prior_count, prior_success_rate
       FROM cypher_sessions WHERE session_id = ?`,
  ).get(sessionId);
  const outcomeRow = db.prepare(
    `SELECT value, failure_pattern, metadata, created_by
       FROM cypher_outcomes WHERE session_id = ? AND signal_kind = 'verdict'`,
  ).get(sessionId);
  const priors = db.prepare(
    `SELECT skill_name, task_class, alpha, beta, total_runs FROM skill_priors`,
  ).all();

  const eligible = demoTools(db, recallMemory);
  const md = renderTrace(
    { ...result, goal: GOAL },
    steps,
    sessionRow,
    outcomeRow ? { ...outcomeRow, metadata: safeJsonParse(outcomeRow.metadata) } : null,
    priors,
    eligible,
    new Date().toISOString(),
  );

  mkdirSync(dirname(TRACE_PAGE), { recursive: true });
  writeProof(TRACE_PAGE, md);
  console.log('[demo-loop-trace] wrote the scanned public trace');



  return result;
}

function safeJsonParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
