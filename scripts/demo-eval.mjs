#!/usr/bin/env node
/**
 * STEP 16 (OSS release) — held-out evaluation with GOLD labels:
 *   DATABASE_PATH=./data/demo.db ANTHROPIC_API_KEY=$KEY npm run demo:eval
 *
 * Imports runLoop DIRECTLY (in-process, same harness as demo-loop-trace.mjs —
 * NOT smoke:outcome, whose loop sections are SKIP stubs) and runs every
 * task from docs/eval/gold.json against the demo database. Each task is a
 * {goal, expected_tool_or_answer} pair where the EXPECTED outcome was
 * authored by a human — this is NOT the loop's own verdict row (grading
 * the loop by its own homework would be self-scoring; see
 * docs/docs/evaluation.md for the method).
 *
 * Label convention (docs/eval/gold.json):
 *   - "tool:<name>"            → the loop must fire that tool (tool_calls)
 *   - any other string         → the loop's final surface must CONTAIN it
 *                                (case-insensitive substring)
 *
 * Output: per-task PASS/FAIL with actual-vs-expected, then a summary line
 * "picked the right tool N/M" which is written back into
 * docs/docs/evaluation.md (score line + mechanical-facts table) so the
 * published numbers always reflect the last real run.
 *
 * Without ANTHROPIC_API_KEY this prints a graceful note and exits 0 (CI
 * never hard-fails without a key); evaluation.md is left untouched.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The src tree is TypeScript — re-exec ourselves under the tsx loader when
// the caller didn't pass it (same loader as `npm run demo` / demo-recall.mjs).
if (!process.execArgv.some((a) => a.includes('tsx'))) {
  const res = spawnSync(process.execPath, ['--import', 'tsx/esm', process.argv[1]], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

const { getDatabase } = await import('../src/db/connection.js');
const { runLoop } = await import('../src/services/cypher/loop.js');
const { computeCost } = await import('../src/services/analyzer.js');

const DB_PATH = process.env.DATABASE_PATH || './data/demo.db';
const GOLD_PATH = new URL('../docs/eval/gold.json', import.meta.url).pathname;
const EVAL_PAGE = new URL('../docs/docs/evaluation.md', import.meta.url).pathname;

const POSTURE = 'generic';
const TASK_CLASS = 'generic';
const MAX_ITERATIONS = 10;

function check(task, result) {
  const label = task.expected_tool_or_answer;
  if (typeof label !== 'string' || !label) {
    return { pass: false, actual: null, reason: 'gold label is not a non-empty string' };
  }
  if (label.startsWith('tool:')) {
    const name = label.slice(5);
    const fired = result.tool_calls.map((t) => t.name);
    return {
      pass: fired.includes(name),
      actual: fired.length ? fired.join(' → ') : '(no tool calls)',
      expected: `tool:${name}`,
    };
  }
  const surface = result.surface ?? '';
  return {
    pass: surface.toLowerCase().includes(label.toLowerCase()),
    actual: surface.slice(0, 300),
    expected: label,
  };
}

async function runOne(db, goal) {
  const sessionId = `cyp_eval_${randomUUID()}`;
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, task_class, user, posture, status)
     VALUES (?, ?, ?, 'demo', ?, 'pending')`,
  ).run(sessionId, goal, TASK_CLASS, POSTURE);

  const result = await runLoop({
    db,
    palace: null,
    goal,
    user: 'demo',
    session_id: sessionId,
    posture: POSTURE,
    task_class: TASK_CLASS,
    confirm_mode: 'auto',
    is_interactive: false,
    halt_flag: { get halted() { return false; }, halt() {} },
    max_iterations: MAX_ITERATIONS,
  });
  return { result, sessionId };
}

/** Fill the published numbers into docs/docs/evaluation.md. */
function updateEvaluationPage(summary, facts) {
  let md = readFileSync(EVAL_PAGE, 'utf8');
  const scoreRe = /picked the right tool \*\*[0-9]+\/[0-9]+\*\*/;
  const nextScore = `picked the right tool **${summary.pass}/${summary.total}**`;
  if (scoreRe.test(md)) {
    md = md.replace(scoreRe, nextScore);
  } else if (!md.includes(nextScore)) {
    md += `\n**Score (held-out, human-labeled):** ${nextScore}\n`;
  }

  const factsRows = {
    '| Mean iterations per task | — |': `| Mean iterations per task | ${facts.meanIterations} |`,
    '| Total tool calls (all tasks) | — |': `| Total tool calls (all tasks) | ${facts.toolCalls} |`,
    '| Total tokens (input/output/cache-read/cache-write) | — |': `| Total tokens (input/output/cache-read/cache-write) | ${facts.tokens} |`,
    '| Est. API cost (USD, per analyzer.ts pricing) | — |': `| Est. API cost (USD, per analyzer.ts pricing) | ${facts.costUsd.toFixed(4)} |`,
  };
  for (const [from, to] of Object.entries(factsRows)) {
    if (md.includes(from)) md = md.replace(from, to);
  }
  writeFileSync(EVAL_PAGE, md);
}

export async function runDemoEval() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      '[demo-eval] requires ANTHROPIC_API_KEY (runLoop makes real paid Anthropic calls). ' +
        'Set the key and re-run to score the held-out set — the method page (docs/docs/evaluation.md) ships with placeholders.',
    );
    return null;
  }

  const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf8'));
  if (!Array.isArray(gold) || gold.length < 8) {
    console.error(`[demo-eval] docs/eval/gold.json must be an array of >= 8 tasks (got ${Array.isArray(gold) ? gold.length : 'not-an-array'})`);
    process.exit(1);
  }

  const db = getDatabase({ path: DB_PATH });
  const rows = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, iterations: 0, toolCalls: 0 };

  for (const task of gold) {
    const { result } = await runOne(db, task.goal);
    const verdict = check(task, result);
    totals.input += result.usage.input_tokens;
    totals.output += result.usage.output_tokens;
    totals.cacheRead += result.usage.cache_read_tokens;
    totals.cacheWrite += result.usage.cache_write_tokens;
    totals.iterations += result.tool_calls.length;
    totals.toolCalls += result.tool_calls.length;
    rows.push({ task, result, verdict });
    console.log(
      `[demo-eval] ${verdict.pass ? 'PASS' : 'FAIL'}  ${task.goal.slice(0, 90)}\n` +
        `    expected=${verdict.expected ?? verdict.reason ?? '(bad label)'}\n` +
        `    actual  =${verdict.actual ?? '(none)'}`,
    );
  }

  const pass = rows.filter((r) => r.verdict.pass).length;
  const total = gold.length;
  console.log(`\n[demo-eval] picked the right tool ${pass}/${total}`);
  for (const r of rows.filter((x) => !x.verdict.pass)) {
    console.log(`[demo-eval] MISS: ${r.task.goal} — expected ${r.verdict.expected}, got ${r.verdict.actual}`);
  }

  const modelRow = db.prepare(
    `SELECT controller_model FROM cypher_steps
      WHERE session_id = ? AND controller_model IS NOT NULL LIMIT 1`,
  );
  let model = null;
  for (const r of rows) {
    model = modelRow.get(r.result.session_id)?.controller_model ?? null;
    if (model) break;
  }
  const costUsd = computeCost(
    model ?? 'claude-sonnet-4-6',
    totals.input,
    totals.output,
    totals.cacheRead,
    totals.cacheWrite,
  );

  updateEvaluationPage(
    { pass, total },
    {
      meanIterations: (totals.iterations / total).toFixed(1),
      toolCalls: totals.toolCalls,
      tokens: `${totals.input}/${totals.output}/${totals.cacheRead}/${totals.cacheWrite}`,
      costUsd,
    },
  );

  console.log(`[demo-eval] wrote score + mechanical facts into ${EVAL_PAGE}`);
  db.close();
  return { pass, total, rows };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runDemoEval()
    .then((r) => { process.exit(r === null ? 0 : 0); })
    .catch((e) => {
      console.error(`[demo-eval] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}